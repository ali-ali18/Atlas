/**
 * Leitura determinística de fontes de alerta: funções puras (sem rede, sem DOM). O seletor CSS roda no
 * `packages/search` (precisa de DOM); aqui moram número localizado, JSON path, regex segura e feed.
 */

export const ALERT_REGEX_MAX = 200;
/** Repetições ilimitadas (`*`, `+`, `{n,}`) permitidas num padrão. */
export const ALERT_REGEX_UNBOUNDED_MAX = 3;
export const ALERT_JSONPATH_MAX = 200;
export const ALERT_FEED_ITEMS_MAX = 100;
export const ALERT_ITEM_TITLE_MAX = 160;

/** Valor numérico em texto de loja ou API: "R$ 1.234,56", "$1,234.56", "1 234,5", "-3,5%", "449.90". null = sem número. */
export function parseLocalizedNumber(text: string): number | null {
	const squeezed = text.replace(/(\d)[\s\u00a0\u202f](?=\d{3}(?!\d))/g, "$1");
	const match = /-?\s*\d[\d.,]*/.exec(squeezed);
	if (!match) return null;
	const negative = match[0].trim().startsWith("-");
	const body = match[0].replace(/[-\s]/g, "").replace(/[.,]+$/, "");
	if (!body) return null;
	const lastDot = body.lastIndexOf(".");
	const lastComma = body.lastIndexOf(",");
	let normalized: string;
	if (lastDot >= 0 && lastComma >= 0) {
		// Os dois: o último separador é o decimal.
		const decimal = lastDot > lastComma ? "." : ",";
		const thousands = decimal === "." ? /,/g : /\./g;
		normalized = body.replace(thousands, "").replace(decimal, ".");
	} else if (lastDot >= 0 || lastComma >= 0) {
		const sep = lastDot >= 0 ? "." : ",";
		const parts = body.split(sep);
		const groupsOfThree = parts.slice(1).every((part) => part.length === 3);
		const leading = parts[0] ?? "";
		// "1.234" / "1,234,567" = milhar; "0.125", "12,5" e "1.2345" = decimal.
		const thousands = groupsOfThree && leading.length >= 1 && leading.length <= 3 && leading !== "0";
		normalized = thousands ? parts.join("") : parts.length === 2 ? `${parts[0]}.${parts[1]}` : "";
	} else {
		normalized = body;
	}
	if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
	const value = Number(normalized);
	return Number.isFinite(value) ? (negative ? -value : value) : null;
}

type PathSegment = string | number;

/** Subconjunto pequeno de JSONPath: `$.a.b[0]["c d"]`. Sem filtros, wildcard nem script (nada é avaliado como código). */
export function parseJsonPath(path: string): PathSegment[] | null {
	if (!path || path.length > ALERT_JSONPATH_MAX) return null;
	let rest = path.trim();
	if (rest.startsWith("$")) rest = rest.slice(1);
	const segments: PathSegment[] = [];
	while (rest.length > 0) {
		let match: RegExpExecArray | null;
		if ((match = /^\.([A-Za-z_][\w-]*)/.exec(rest))) segments.push(match[1]!);
		else if ((match = /^\[(-?\d{1,6})\]/.exec(rest))) segments.push(Number(match[1]));
		else if ((match = /^\[(?:"([^"\\]{1,80})"|'([^'\\]{1,80})')\]/.exec(rest))) segments.push((match[1] ?? match[2])!);
		else if (segments.length === 0 && (match = /^([A-Za-z_][\w-]*)/.exec(rest))) segments.push(match[1]!);
		else return null;
		rest = rest.slice(match[0].length);
		if (segments.length > 20) return null;
	}
	return segments.length > 0 ? segments : null;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Valor no caminho, ou undefined. Só propriedades próprias (nunca protótipo). */
export function readJsonPath(data: unknown, path: string): unknown {
	const segments = parseJsonPath(path);
	if (!segments) return undefined;
	let current: unknown = data;
	for (const segment of segments) {
		if (typeof segment === "number") {
			if (!Array.isArray(current)) return undefined;
			current = current.at(segment);
		} else {
			if (FORBIDDEN_KEYS.has(segment) || !current || typeof current !== "object" || Array.isArray(current)) return undefined;
			if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
			current = (current as Record<string, unknown>)[segment];
		}
	}
	return current;
}

/** Texto de um valor lido do JSON (número ou texto); objeto/array/null não é valor de alerta. */
export function jsonValueText(value: unknown): string | null {
	if (typeof value === "string") return value.trim() || null;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return null;
}

/**
 * Regex que o modelo propõe só entra se não puder explodir: sem retrovisor/lookaround, sem quantificador
 * dentro de grupo quantificado (`(a+)+`), sem alternância em grupo repetido e com repetição limitada.
 * Retorna o motivo da recusa, ou null quando é segura.
 */
export function unsafeRegexReason(pattern: string): string | null {
	if (!pattern) return "empty pattern";
	if (pattern.length > ALERT_REGEX_MAX) return `pattern longer than ${ALERT_REGEX_MAX} characters`;
	try {
		new RegExp(pattern, "i");
	} catch {
		return "invalid regular expression";
	}
	if (/\\[1-9]|\\k</.test(pattern)) return "backreferences are not allowed";
	if (/\(\?(?:=|!|<=|<!)/.test(pattern)) return "lookahead/lookbehind is not allowed";
	const stack: Array<{ quantified: boolean; alternation: boolean }> = [];
	// Repetições ilimitadas em sequência (\d*\d*\d*x) explodem em tempo polinomial: poucas por padrão. O teto de
	// tempo na execução (worker com orçamento, em packages/search) cobre o que a checagem estática não vê.
	let unbounded = 0;
	let escaped = false;
	let inClass = false;
	for (let i = 0; i < pattern.length; i += 1) {
		const ch = pattern[i]!;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (inClass) {
			if (ch === "]") inClass = false;
			continue;
		}
		if (ch === "[") inClass = true;
		else if (ch === "(") stack.push({ quantified: false, alternation: false });
		else if (ch === "|" && stack.length > 0) stack[stack.length - 1]!.alternation = true;
		else if (ch === ")") {
			const group = stack.pop();
			const next = pattern[i + 1];
			const repeats = next === "*" || next === "+" || (next === "{" && /^\{\d+,\d*\}/.test(pattern.slice(i + 1)));
			if (group && repeats && (group.quantified || group.alternation)) return "nested repetition (catastrophic backtracking risk)";
			if (group && repeats && stack.length > 0) stack[stack.length - 1]!.quantified = true;
			if (group?.quantified && stack.length > 0) stack[stack.length - 1]!.quantified = true;
		} else if (ch === "*" || ch === "+" || ch === "{") {
			if (ch !== "{" || /^\{\d+,\}/.test(pattern.slice(i))) {
				unbounded += 1;
				if (unbounded > ALERT_REGEX_UNBOUNDED_MAX) return `more than ${ALERT_REGEX_UNBOUNDED_MAX} unbounded repetitions (* + {n,})`;
			}
			if (ch === "{") {
				const range = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i));
				if (!range) continue;
				if (Number(range[1]) > 100 || Number(range[2] ?? 0) > 100) return "repetition counts above 100 are not allowed";
				if (range[2] !== undefined && range[2] === "" && stack.length > 0) stack[stack.length - 1]!.quantified = true;
				continue;
			}
			if (stack.length > 0) stack[stack.length - 1]!.quantified = true;
		}
	}
	return null;
}

export type AlertFeedItem = { id: string; title: string; link?: string };

/** Hash curto e estável (FNV-1a 32 bits) para identificar item sem guid. */
export function hashAlertText(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeXmlText(raw: string): string {
	return stripTags(stripCdata(raw))
		.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
			if (name[0] === "#") {
				const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
				return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
			}
			return ENTITIES[name.toLowerCase()] ?? whole;
		})
		.replace(/\s+/g, " ")
		.trim();
}

// O XML do feed vem de fora (até 5 MB): tudo aqui é varredura linear com indexOf. Regex com `[\s\S]*?` até
// um fechamento ficava quadrática em entradas com muitas aberturas sem fechamento (`<item ` repetido, CDATA aberto).
function stripCdata(raw: string): string {
	let out = "";
	let from = 0;
	for (;;) {
		const start = raw.indexOf("<![CDATA[", from);
		if (start < 0) return out + raw.slice(from);
		const end = raw.indexOf("]]>", start + 9);
		if (end < 0) return out + raw.slice(from);
		out += raw.slice(from, start) + raw.slice(start + 9, end);
		from = end + 3;
	}
}

/** Troca `<...>` por espaço; um `<` sem `>` depois fica como texto (linear, sem regex). */
function stripTags(raw: string): string {
	let out = "";
	let from = 0;
	for (;;) {
		const open = raw.indexOf("<", from);
		if (open < 0) return out + raw.slice(from);
		const close = raw.indexOf(">", open + 1);
		if (close < 0) return out + raw.slice(from);
		out += raw.slice(from, open) + " ";
		from = close + 1;
	}
}

/** Posição do fim da tag de abertura `<name ...>` / `<name>` a partir de `at` (ou -1). */
function openTagEnd(lower: string, at: number, name: string): number {
	const after = lower[at + 1 + name.length];
	if (after !== ">" && after !== " " && after !== "\t" && after !== "\n" && after !== "\r" && after !== "/") return -1;
	const close = lower.indexOf(">", at);
	if (close < 0) return -2; // nenhum ">" daqui pra frente: não existe mais tag completa
	if (lower[close - 1] === "/") return -1;
	return close + 1;
}

/** Primeiro trecho `<name ...>conteúdo</name>` em `text` (sem diferenciar maiúsculas), a partir de `from`. */
function findElement(text: string, lower: string, names: readonly string[], from: number): { start: number; contentStart: number; contentEnd: number; end: number } | null {
	let cursor = from;
	for (;;) {
		let best = -1;
		let bestName = "";
		for (const name of names) {
			const at = lower.indexOf(`<${name}`, cursor);
			if (at >= 0 && (best < 0 || at < best)) { best = at; bestName = name; }
		}
		if (best < 0) return null;
		const contentStart = openTagEnd(lower, best, bestName);
		if (contentStart === -2) return null;
		if (contentStart < 0) { cursor = best + 1; continue; }
		const closing = lower.indexOf(`</${bestName}>`, contentStart);
		if (closing < 0) return null;
		return { start: best, contentStart, contentEnd: closing, end: closing + bestName.length + 3 };
	}
}

function tagText(block: string, tag: string): string | null {
	const found = findElement(block, block.toLowerCase(), [tag], 0);
	return found ? decodeXmlText(block.slice(found.contentStart, found.contentEnd)) : null;
}

/** RSS 2.0 e Atom, tolerante: id = guid/id, senão link, senão hash do título. Até 100 itens, na ordem do feed. */
export function parseFeedItems(xml: string): AlertFeedItem[] {
	const items: AlertFeedItem[] = [];
	const lower = xml.toLowerCase();
	let from = 0;
	while (items.length < ALERT_FEED_ITEMS_MAX) {
		const found = findElement(xml, lower, ["item", "entry"], from);
		if (!found) break;
		from = found.end;
		const block = xml.slice(found.start, found.end);
		const title = (tagText(block, "title") ?? "").slice(0, ALERT_ITEM_TITLE_MAX);
		const atomHref = /<link\b[^>]*\bhref=["']([^"']+)["']/i.exec(block)?.[1];
		const link = decodeXmlText(atomHref ?? tagText(block, "link") ?? "") || undefined;
		const guid = tagText(block, "guid") ?? tagText(block, "id");
		const id = (guid || link || (title ? `t:${hashAlertText(title)}` : "")).slice(0, 300);
		if (!id) continue;
		items.push({ id, title: title || link || id, ...(link ? { link } : {}) });
	}
	return items;
}

/** Chave estável do item: guid/link se vierem, senão hash do título. */
export function alertItemKey(item: { id?: string; link?: string; title: string }): string {
	return (item.id || item.link || `t:${hashAlertText(item.title)}`).slice(0, 300);
}

export const ALERT_EXTERNAL_TEXT_MAX = 80;

/**
 * Texto que veio de fora (página, feed) e vai aparecer numa mensagem do bot: sem caracteres de controle, de
 * direção ou invisíveis, sem marcação (`<>[]{}\`` e aspas) e sem quebra de linha, em no máximo 80 caracteres.
 * Não impede que uma frase estranha apareça, mas ela não vira formatação nem ordem em linha própria.
 */
export function sanitizeAlertExternalText(text: string, max = ALERT_EXTERNAL_TEXT_MAX): string {
	const clean = text
		.normalize("NFKC")
		.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
		.replace(/[<>\[\]{}`"“”'‘’\\|*_#~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** O valor externo entre aspas: na mensagem fica claro que é citação do site, não fala do bot. */
export function quoteAlertExternalText(text: string): string {
	return `“${sanitizeAlertExternalText(text)}”`;
}
