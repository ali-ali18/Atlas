// Markdown das falas do bot: o subconjunto que o bot usa no chat (títulos, listas, negrito, itálico, `código`,
// bloco de código, citação, links). Sem biblioteca: o app não carrega um parser inteiro por causa disso, e a
// função pura é testada. Só http(s) vira link (nada de `javascript:` vindo do modelo).

export type Inline =
	| { type: "text"; text: string }
	| { type: "bold"; children: Inline[] }
	| { type: "italic"; children: Inline[] }
	| { type: "code"; text: string }
	| { type: "link"; text: string; url: string };

export type Block =
	| { type: "paragraph"; inline: Inline[] }
	| { type: "heading"; level: 1 | 2 | 3; inline: Inline[] }
	| { type: "list"; ordered: boolean; start: number; items: Inline[][] }
	| { type: "code"; text: string; lang: string }
	| { type: "quote"; inline: Inline[] }
	| { type: "table"; header: Inline[][]; rows: Inline[][][] }
	| { type: "rule" };

const SAFE_URL = /^https?:\/\/[^\s<>]+$/i;
export const isSafeUrl = (url: string): boolean => SAFE_URL.test(url.trim());

/** Sinal de pontuação que não pertence à URL quando ela termina uma frase. */
function trimUrlTail(url: string): { url: string; tail: string } {
	const match = /[.,;:!?)\]]+$/.exec(url);
	return match ? { url: url.slice(0, match.index), tail: match[0] } : { url, tail: "" };
}

/** Janela olhada à frente em cada marcador: negrito, itálico, código e link maiores que isto ficam como texto. */
const WINDOW = 1_500;
/** Acima disto o resto vira texto puro: o parser e a tela não podem travar com uma resposta enorme (ou hostil). */
export const MARKDOWN_MAX_CHARS = 20_000;

/** Próximo caractere que pode abrir formatação; o texto comum entre eles é copiado de uma vez (custo linear). */
const SPECIAL = /[`*_[]|https?:\/\//g;

/** Fecha `**x**`/`__x__`: acha o par com `indexOf` dentro da janela (sem regex preguiçosa, que era quadrática). */
function matchDouble(source: string, i: number, mark: "**" | "__"): { end: number; inner: string } | null {
	if (!source.startsWith(mark, i)) return null;
	const first = source[i + 2];
	if (first === undefined || /\s/.test(first)) return null;
	const limit = Math.min(source.length, i + WINDOW);
	for (let close = source.indexOf(mark, i + 3); close !== -1 && close < limit; close = source.indexOf(mark, close + 1)) {
		if (!/\s/.test(source[close - 1]!)) return { end: close + 2, inner: source.slice(i + 2, close) };
	}
	return null;
}

function matchSingle(source: string, i: number, mark: "*" | "_"): { end: number; inner: string } | null {
	const first = source[i + 1];
	if (first === undefined || /[\s*_]/.test(first) || source[i + 1] === mark) return null;
	const limit = Math.min(source.length, i + WINDOW);
	for (let close = source.indexOf(mark, i + 2); close !== -1 && close < limit; close = source.indexOf(mark, close + 1)) {
		const between = source.slice(i + 1, close);
		if (between.includes("\n")) return null;
		const before = source[close - 1]!;
		if (/[\s*_]/.test(before) || source[close + 1] === mark) continue;
		if (mark === "_" && /\w/.test(source[close + 1] ?? "")) continue;
		return { end: close + 1, inner: between };
	}
	return null;
}

export function parseInline(source: string): Inline[] {
	const out: Inline[] = [];
	let text = "";
	const flush = () => {
		if (text) out.push({ type: "text", text });
		text = "";
	};
	let i = 0;
	while (i < source.length) {
		SPECIAL.lastIndex = i;
		const found = SPECIAL.exec(source);
		const next = found ? found.index : source.length;
		if (next > i) {
			text += source.slice(i, next);
			i = next;
			continue;
		}
		const char = source[i]!;
		const window = source.slice(i, i + WINDOW);
		let match: RegExpExecArray | null;
		let double: { end: number; inner: string } | null;
		if (char === "`" && (match = /^`([^`\n]+)`/.exec(window))) {
			flush();
			out.push({ type: "code", text: match[1]! });
			i += match[0].length;
		} else if ((char === "*" && (double = matchDouble(source, i, "**"))) || (char === "_" && (double = matchDouble(source, i, "__")))) {
			flush();
			out.push({ type: "bold", children: parseInline(double.inner) });
			i = double.end;
		} else if (char === "*" || char === "_") {
			// `_` dentro de palavra (snake_case) não é itálico: só vale na borda da palavra.
			const single = char === "_" && i > 0 && /\w/.test(source[i - 1]!) ? null : matchSingle(source, i, char);
			if (single) {
				flush();
				out.push({ type: "italic", children: parseInline(single.inner) });
				i = single.end;
			} else {
				text += char;
				i += 1;
			}
		} else if (char === "[" && (match = /^\[([^\]\n]{1,300})\]\(([^)\s]{1,1000})\)/.exec(window))) {
			if (isSafeUrl(match[2]!)) {
				flush();
				out.push({ type: "link", text: match[1]!, url: match[2]! });
			} else text += match[1]!;
			i += match[0].length;
		} else if (char === "h" && (match = /^https?:\/\/[^\s<>]+/i.exec(window)) && (i === 0 || !/\w/.test(source[i - 1]!))) {
			const { url, tail } = trimUrlTail(match[0]);
			flush();
			out.push({ type: "link", text: url, url });
			text += tail;
			i += match[0].length;
		} else {
			text += char;
			i += 1;
		}
	}
	flush();
	return out;
}

/** Divide uma linha de tabela `| a | b |` em células (a barra escapada `\\|` fica no texto). */
export function splitTableRow(line: string): string[] {
	let text = line.trim();
	if (text.startsWith("|")) text = text.slice(1);
	if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
	return text.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
/** Linha de separação (`|---|:--:|`) com pelo menos uma barra, para não confundir com a régua `---`. */
export const isTableSeparator = (line: string): boolean => line.includes("|") && TABLE_SEPARATOR.test(line);

const BULLET = /^\s*[-*•+]\s+(.*)$/;
const ORDERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;

export function parseMarkdown(source: string): Block[] {
	if (source.length > MARKDOWN_MAX_CHARS) {
		// Os primeiros ~20 mil caracteres com formatação (cortando numa quebra de linha); o resto, como texto puro.
		const cut = source.lastIndexOf("\n", MARKDOWN_MAX_CHARS);
		const at = cut > MARKDOWN_MAX_CHARS / 2 ? cut : MARKDOWN_MAX_CHARS;
		const head = parseMarkdown(source.slice(0, at));
		const tail = source.slice(at).trim();
		return tail ? [...head, { type: "paragraph", inline: [{ type: "text", text: tail }] }] : head;
	}
	const lines = source.replace(/\r\n/g, "\n").split("\n");
	const blocks: Block[] = [];
	let paragraph: string[] = [];
	const flushParagraph = () => {
		if (paragraph.length) blocks.push({ type: "paragraph", inline: parseInline(paragraph.join("\n")) });
		paragraph = [];
	};
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
		if (fence) {
			flushParagraph();
			const body: string[] = [];
			index += 1;
			while (index < lines.length && !/^\s*```\s*$/.test(lines[index]!)) {
				body.push(lines[index]!);
				index += 1;
			}
			blocks.push({ type: "code", text: body.join("\n"), lang: fence[1] ?? "" });
			continue;
		}
		if (!line.trim()) {
			flushParagraph();
			continue;
		}
		let match: RegExpExecArray | null;
		if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1]!)) {
			flushParagraph();
			const header = splitTableRow(line);
			const rows: Inline[][][] = [];
			index += 2;
			while (index < lines.length && lines[index]!.trim() && lines[index]!.includes("|")) {
				const cells = splitTableRow(lines[index]!);
				// Linha curta ganha células vazias; longa perde o excedente (o cabeçalho manda nas colunas).
				rows.push(header.map((_, column) => parseInline(cells[column] ?? "")));
				index += 1;
			}
			index -= 1;
			blocks.push({ type: "table", header: header.map((cell) => parseInline(cell)), rows });
		} else if ((match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
			flushParagraph();
			blocks.push({ type: "heading", level: Math.min(3, match[1]!.length) as 1 | 2 | 3, inline: parseInline(match[2]!) });
		} else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			flushParagraph();
			blocks.push({ type: "rule" });
		} else if (BULLET.test(line) || ORDERED.test(line)) {
			flushParagraph();
			const ordered = ORDERED.test(line) && !BULLET.test(line);
			const start = ordered ? Number(ORDERED.exec(line)![1]) : 1;
			const items: Inline[][] = [];
			while (index < lines.length) {
				const current = lines[index]!;
				const item = ordered ? ORDERED.exec(current) : BULLET.exec(current);
				if (item) {
					items.push(parseInline(ordered ? item[2]! : item[1]!));
				} else if (current.trim() && /^\s{2,}\S/.test(current) && items.length) {
					// continuação recuada do item anterior
					items[items.length - 1] = [...items[items.length - 1]!, { type: "text", text: `\n${current.trim()}` }];
				} else break;
				index += 1;
			}
			index -= 1;
			blocks.push({ type: "list", ordered, start, items });
		} else if ((match = /^>\s?(.*)$/.exec(line))) {
			flushParagraph();
			const quoted = [match[1]!];
			while (index + 1 < lines.length && /^>\s?/.test(lines[index + 1]!)) {
				index += 1;
				quoted.push(lines[index]!.replace(/^>\s?/, ""));
			}
			blocks.push({ type: "quote", inline: parseInline(quoted.join("\n")) });
		} else {
			paragraph.push(line);
		}
	}
	flushParagraph();
	return blocks;
}

/** Texto puro de um trecho inline (sem marcas), para medir a coluna. */
export function inlineText(nodes: readonly Inline[]): string {
	// `código` é desenhado com um espaço de cada lado: entra na conta da largura.
	return nodes.map((node) => (node.type === "bold" || node.type === "italic" ? inlineText(node.children) : node.type === "code" ? ` ${node.text} ` : node.text)).join("");
}

/** Mesma regra do web (`cellWidthClass`): número, moeda, data ou % curto nunca quebra. */
const COMPACT_VALUE = /^[\sR$US€£\d.,:%/+()\-–]+$/;
const CHAR_WIDTH = 9.7;
const CELL_PADDING = 37;
/** 8 rem e 22 rem do web (16 pt por rem). */
const TEXT_MIN = 128;
const TEXT_MAX = 352;

/**
 * Largura (pt) de cada coluna da tabela, como o web faz com CSS: valor curto (número, moeda, data) ocupa o que
 * precisa e não quebra; texto livre vai de 8 a 22 rem. O RN não mede por conteúdo, então estimamos por caractere.
 */
export function tableColumnWidths(header: Inline[][], rows: Inline[][][]): number[] {
	return header.map((_, column) => {
		let width = 0;
		for (const row of [header, ...rows]) {
			const text = inlineText(row[column] ?? []).trim();
			const natural = text.length * CHAR_WIDTH + CELL_PADDING;
			const compact = text.length > 0 && text.length <= 24 && COMPACT_VALUE.test(text);
			width = Math.max(width, compact ? natural : Math.min(TEXT_MAX, Math.max(TEXT_MIN, natural)));
		}
		return Math.ceil(width);
	});
}

/** Pedaço de uma fala do bot: texto corrido (um balão) ou uma tabela (cartão próprio, como no Grok). */
export type Segment = { kind: "bubble"; blocks: Block[] } | { kind: "table"; block: Extract<Block, { type: "table" }> };

/** Separa a fala nos pontos das tabelas: o que vem antes e depois vira balão, cada tabela vira um cartão. */
export function splitSegments(blocks: readonly Block[]): Segment[] {
	const segments: Segment[] = [];
	let current: Block[] = [];
	for (const block of blocks) {
		if (block.type === "table") {
			if (current.length) segments.push({ kind: "bubble", blocks: current });
			current = [];
			segments.push({ kind: "table", block });
		} else current.push(block);
	}
	if (current.length) segments.push({ kind: "bubble", blocks: current });
	return segments;
}
