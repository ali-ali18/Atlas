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
	| { type: "rule" };

const SAFE_URL = /^https?:\/\/[^\s<>]+$/i;
export const isSafeUrl = (url: string): boolean => SAFE_URL.test(url.trim());

/** Sinal de pontuação que não pertence à URL quando ela termina uma frase. */
function trimUrlTail(url: string): { url: string; tail: string } {
	const match = /[.,;:!?)\]]+$/.exec(url);
	return match ? { url: url.slice(0, match.index), tail: match[0] } : { url, tail: "" };
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
		const rest = source.slice(i);
		let match: RegExpExecArray | null;
		if ((match = /^`([^`\n]+)`/.exec(rest))) {
			flush();
			out.push({ type: "code", text: match[1]! });
			i += match[0].length;
		} else if ((match = /^\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/.exec(rest)) ?? (match = /^__(?=\S)([\s\S]+?)(?<=\S)__/.exec(rest))) {
			flush();
			out.push({ type: "bold", children: parseInline(match[1]!) });
			i += match[0].length;
		} else if ((match = /^\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/.exec(rest)) ?? (match = /^_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?![\w_])/.exec(rest))) {
			// `_` dentro de palavra (snake_case) não é itálico: só vale na borda da palavra.
			if (match[0].startsWith("_") && i > 0 && /\w/.test(source[i - 1]!)) {
				text += source[i];
				i += 1;
				continue;
			}
			flush();
			out.push({ type: "italic", children: parseInline(match[1]!) });
			i += match[0].length;
		} else if ((match = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest))) {
			if (isSafeUrl(match[2]!)) {
				flush();
				out.push({ type: "link", text: match[1]!, url: match[2]! });
			} else text += match[1]!;
			i += match[0].length;
		} else if ((match = /^https?:\/\/[^\s<>]+/i.exec(rest)) && (i === 0 || !/\w/.test(source[i - 1]!))) {
			const { url, tail } = trimUrlTail(match[0]);
			flush();
			out.push({ type: "link", text: url, url });
			text += tail;
			i += match[0].length;
		} else {
			text += source[i];
			i += 1;
		}
	}
	flush();
	return out;
}

const BULLET = /^\s*[-*•+]\s+(.*)$/;
const ORDERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;

export function parseMarkdown(source: string): Block[] {
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
		if ((match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
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
