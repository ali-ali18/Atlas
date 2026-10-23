/**
 * Transporte tolerante (estilo Hermes): o modelo chama `Navigate`, `browser-snapshot` ou
 * `mcp_bling_listProducts` em vez do nome exato. Puro e determinístico: só corrige quando há UM
 * alvo confiável (nome normalizado igual, prefixo de namespace, apelido conhecido ou poucas letras
 * trocadas). Ambíguo ou sem par = erro com os nomes mais próximos; nunca escolhe às cegas.
 *
 * Segurança: correção por aproximação (letra trocada, apelido) só cai em tool de LEITURA. Escrita
 * só é alcançada quando o nome normalizado bate exatamente (caixa, separador ou prefixo).
 */

export type ToolNameCandidate = {
	name: string;
	/** Tool só de leitura (pode ser alvo de correção aproximada). */
	readOnly: boolean;
};

export type ToolNameRepair =
	| { kind: "exact"; name: string }
	| { kind: "repaired"; name: string; from: string; via: "normalized" | "prefix" | "alias" | "fuzzy" }
	| { kind: "ambiguous"; from: string; candidates: string[] }
	| { kind: "unknown"; from: string; suggestions: string[] };

/** Apelidos frequentes de modelos treinados em outros harnesses → tool do Atlas (todas de leitura). */
export const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
	browser_navigate: "navigate",
	goto: "navigate",
	go_to: "navigate",
	open_url: "navigate",
	visit: "navigate",
	take_screenshot: "screenshot",
	browser_screenshot: "screenshot",
	search_web: "web_search",
	google_search: "web_search",
	internet_search: "web_search",
	fetch_url: "web_extract",
	read_url: "web_extract",
	web_fetch: "web_extract",
	fetch: "web_extract",
	tool_search: "mcp_tool_search",
	search_tools: "mcp_tool_search",
	find_tools: "mcp_tool_search",
};

/** Prefixos que alguns modelos colam no nome (`functions.navigate`, `default_api:navigate`). */
const WRAPPER_PREFIX = /^(functions|function|default_api|tools?|api)[.:/]+/i;

/** Corta lixo de XML/aspas que vaza no nome (`navigate" parameter="url"`). */
function cleanRawName(raw: string): string {
	let name = raw.trim();
	for (const separator of ['"', "'", "<", ">", "(", "{"]) {
		const at = name.indexOf(separator);
		if (at > 0) name = name.slice(0, at);
	}
	return name.trim().replace(WRAPPER_PREFIX, "");
}

/** Chave insensível a caixa e separador: `mcp__bling__listProducts` = `mcp-bling-list_products`. */
export function looseToolKey(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Forma para a distância de edição: minúsculas e separadores únicos. */
function editKey(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

/** Variantes sem namespace de uma tool MCP (`mcp__slug__tool` → `slug__tool`, `tool`). */
function namespaceVariants(name: string): string[] {
	const parts = name.split("__");
	if (parts.length < 3 || parts[0] !== "mcp") return [];
	return [parts.slice(1).join("__"), parts.slice(2).join("__")];
}

/** Distância de Damerau-Levenshtein restrita (transposição de vizinhas conta 1). */
export function editDistance(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
	if (a === b) return 0;
	if (Math.abs(a.length - b.length) > max) return max + 1;
	const rows = a.length + 1;
	const cols = b.length + 1;
	const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
	for (let i = 1; i < rows; i += 1) {
		let rowMin = Number.POSITIVE_INFINITY;
		for (let j = 1; j < cols; j += 1) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let value = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, d[i - 2]![j - 2]! + 1);
			d[i]![j] = value;
			rowMin = Math.min(rowMin, value);
		}
		if (rowMin > max) return max + 1;
	}
	return d[rows - 1]![cols - 1]!;
}

/** Teto estrito da correção aproximada: 1 edição até 8 letras, 2 a partir de 9 (nunca nome curto demais). */
function fuzzyLimit(length: number): number {
	if (length < 4) return 0;
	return length >= 9 ? 2 : 1;
}

function closest(raw: string, candidates: readonly ToolNameCandidate[], limit = 3): string[] {
	const key = editKey(raw);
	return candidates
		.map((candidate) => ({
			name: candidate.name,
			distance: Math.min(editDistance(key, editKey(candidate.name)), ...namespaceVariants(candidate.name).map((variant) => editDistance(key, editKey(variant)))),
		}))
		.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
		.slice(0, limit)
		.map((item) => item.name);
}

function unique(names: Iterable<string>): string[] {
	return [...new Set(names)];
}

/**
 * Resolve o nome que o modelo chamou contra as tools executáveis do run. `known` são nomes que o
 * executor trata por conta própria (aliases antigos, tools guardadas) e nunca são corrigidos.
 */
export function repairToolName(raw: string, candidates: readonly ToolNameCandidate[], known: ReadonlySet<string> = new Set()): ToolNameRepair {
	const byName = new Map(candidates.map((candidate) => [candidate.name, candidate] as const));
	if (byName.has(raw) || known.has(raw)) return { kind: "exact", name: raw };
	const cleaned = cleanRawName(raw);
	if (!cleaned) return { kind: "unknown", from: raw, suggestions: closest(raw, candidates) };
	if (byName.has(cleaned)) return { kind: "repaired", name: cleaned, from: raw, via: "normalized" };
	if (known.has(cleaned)) return { kind: "repaired", name: cleaned, from: raw, via: "normalized" };

	// 1. Mesmo nome a menos de caixa e separadores.
	const loose = looseToolKey(cleaned);
	const normalized = unique(candidates.filter((candidate) => looseToolKey(candidate.name) === loose).map((candidate) => candidate.name));
	if (normalized.length === 1) return { kind: "repaired", name: normalized[0]!, from: raw, via: "normalized" };
	if (normalized.length > 1) return { kind: "ambiguous", from: raw, candidates: normalized.slice(0, 3) };

	// 2. Namespace de conector faltando ou sobrando (`bling__listProducts`, `listProducts`, `mcp__x__navigate`).
	// Só o nome próprio, sem o conector (`listProducts`): vale para leitura; escrita exige o conector no nome.
	const prefixed = unique(
		candidates
			.filter((candidate) => {
				const [withSlug, own] = namespaceVariants(candidate.name);
				if (withSlug !== undefined && looseToolKey(withSlug) === loose) return true;
				return own !== undefined && looseToolKey(own) === loose && candidate.readOnly;
			})
			.map((candidate) => candidate.name),
	);
	const strippedOwn = cleaned.split("__").length >= 3 && /^mcp_*/i.test(cleaned) ? looseToolKey(cleaned.split("__").slice(2).join("__")) : "";
	const unprefixed = strippedOwn ? unique(candidates.filter((candidate) => !candidate.name.startsWith("mcp__") && looseToolKey(candidate.name) === strippedOwn).map((candidate) => candidate.name)) : [];
	const byPrefix = unique([...prefixed, ...unprefixed]);
	if (byPrefix.length === 1) return { kind: "repaired", name: byPrefix[0]!, from: raw, via: "prefix" };
	if (byPrefix.length > 1) return { kind: "ambiguous", from: raw, candidates: byPrefix.slice(0, 3) };

	// 3. Apelido conhecido (só leitura, e só se a tool existe no run).
	const aliasTarget = TOOL_NAME_ALIASES[editKey(cleaned)];
	if (aliasTarget && byName.get(aliasTarget)?.readOnly) return { kind: "repaired", name: aliasTarget, from: raw, via: "alias" };

	// 4. Poucas letras trocadas: alvo único, só leitura, e sem rival de leitura ou escrita à mesma distância.
	const key = editKey(cleaned);
	const max = fuzzyLimit(key.length);
	if (max > 0) {
		const scored = candidates
			.map((candidate) => ({
				candidate,
				distance: Math.min(
					editDistance(key, editKey(candidate.name), max),
					...namespaceVariants(candidate.name).map((variant) => editDistance(key, editKey(variant), max)),
				),
			}))
			.filter((item) => item.distance <= max)
			.sort((a, b) => a.distance - b.distance);
		const best = scored[0];
		if (best) {
			const tied = unique(scored.filter((item) => item.distance === best.distance).map((item) => item.candidate.name));
			if (tied.length > 1) return { kind: "ambiguous", from: raw, candidates: tied.slice(0, 3) };
			if (best.candidate.readOnly) return { kind: "repaired", name: best.candidate.name, from: raw, via: "fuzzy" };
		}
	}
	return { kind: "unknown", from: raw, suggestions: closest(cleaned, candidates) };
}

/** Nota curta anexada ao resultado quando o nome foi corrigido (o modelo aprende o nome certo). */
export function repairedToolNote(from: string, to: string): string {
	return `Called \`${from}\` as \`${to}\` (the exact tool name is \`${to}\`).`;
}

/** Complemento da mensagem de tool inexistente: os nomes mais próximos ou os candidatos empatados. */
export function unresolvedToolHint(repair: ToolNameRepair): string {
	if (repair.kind === "ambiguous") return `The name \`${repair.from}\` matches more than one tool (${repair.candidates.join(", ")}); call one of them by its exact name.`;
	if (repair.kind === "unknown" && repair.suggestions.length > 0) return `Closest tools: ${repair.suggestions.join(", ")}.`;
	return "";
}

// --- Argumentos JSON ---

export type ArgsRepair =
	| { ok: true; value: Record<string, unknown>; repaired: boolean }
	| { ok: false; error: string };

/**
 * Parser leniente e seguro (subconjunto de JSON5): aspas simples, chave sem aspas, vírgula sobrando
 * e comentários. Não executa nada nem inventa fecho: JSON cortado continua inválido.
 */
function parseLenient(text: string): unknown {
	let at = 0;
	const fail = (message: string): never => {
		throw new Error(`${message} at position ${at}`);
	};
	const skip = () => {
		for (;;) {
			while (at < text.length && /\s/.test(text[at]!)) at += 1;
			if (text.startsWith("//", at)) {
				const end = text.indexOf("\n", at);
				at = end < 0 ? text.length : end + 1;
				continue;
			}
			if (text.startsWith("/*", at)) {
				const end = text.indexOf("*/", at + 2);
				if (end < 0) fail("unterminated comment");
				at = end + 2;
				continue;
			}
			return;
		}
	};
	const parseString = (): string => {
		const quote = text[at]!;
		at += 1;
		let out = "";
		while (at < text.length) {
			const char = text[at]!;
			if (char === quote) {
				at += 1;
				return out;
			}
			if (char === "\\") {
				const next = text[at + 1];
				if (next === undefined) fail("unterminated string");
				if (next === "u") {
					const hex = text.slice(at + 2, at + 6);
					if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid unicode escape");
					out += String.fromCharCode(Number.parseInt(hex, 16));
					at += 6;
					continue;
				}
				const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "/": "/", "\\": "\\", '"': '"', "'": "'" };
				out += escapes[next!] ?? next!;
				at += 2;
				continue;
			}
			if (char === "\n") fail("unterminated string");
			out += char;
			at += 1;
		}
		return fail("unterminated string");
	};
	const parseValue = (): unknown => {
		skip();
		const char = text[at];
		if (char === undefined) return fail("unexpected end of input");
		if (char === "{") {
			at += 1;
			const object: Record<string, unknown> = {};
			for (;;) {
				skip();
				if (text[at] === "}") {
					at += 1;
					return object;
				}
				let key: string;
				if (text[at] === '"' || text[at] === "'") key = parseString();
				else {
					const match = /^[A-Za-z_$][\w$-]*/.exec(text.slice(at));
					if (!match) return fail("expected a key");
					key = match[0];
					at += key.length;
				}
				skip();
				if (text[at] !== ":") fail("expected ':'");
				at += 1;
				object[key] = parseValue();
				skip();
				if (text[at] === ",") {
					at += 1;
					continue;
				}
				if (text[at] === "}") {
					at += 1;
					return object;
				}
				fail("expected ',' or '}'");
			}
		}
		if (char === "[") {
			at += 1;
			const array: unknown[] = [];
			for (;;) {
				skip();
				if (text[at] === "]") {
					at += 1;
					return array;
				}
				array.push(parseValue());
				skip();
				if (text[at] === ",") {
					at += 1;
					continue;
				}
				if (text[at] === "]") {
					at += 1;
					return array;
				}
				fail("expected ',' or ']'");
			}
		}
		if (char === '"' || char === "'") return parseString();
		const number = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(at));
		if (number) {
			at += number[0].length;
			return Number(number[0]);
		}
		for (const [word, value] of [["true", true], ["false", false], ["null", null]] as const) {
			if (text.startsWith(word, at)) {
				at += word.length;
				return value;
			}
		}
		return fail(`unexpected character '${char}'`);
	};
	const value = parseValue();
	skip();
	if (at < text.length) fail("unexpected trailing content");
	return value;
}

function asObject(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Cerca de markdown em volta do JSON (```json ... ```). */
function stripFence(text: string): string {
	const match = /^```[a-zA-Z0-9]*\s*\n?([\s\S]*?)\n?```$/.exec(text.trim());
	return match ? match[1]!.trim() : text;
}

/**
 * Argumentos da chamada. JSON válido passa como está; JSON de objeto embrulhado numa string e JSON
 * malformado de forma reconhecível (vírgula sobrando, aspas simples, chave sem aspas, cerca de
 * markdown) são reparados. O resto falha com o erro do parse original.
 */
export function repairToolArguments(raw: string): ArgsRepair {
	const text = raw?.trim() ? raw : "{}";
	let strictError: string;
	try {
		const parsed = JSON.parse(text) as unknown;
		const object = asObject(parsed);
		if (object) return { ok: true, value: object, repaired: false };
		if (typeof parsed === "string") {
			const inner = repairToolArguments(parsed);
			if (inner.ok) return { ok: true, value: inner.value, repaired: true };
		}
		// Valor que não é objeto (número, lista): mantém o comportamento antigo (sem argumentos).
		return { ok: true, value: {}, repaired: false };
	} catch (error) {
		strictError = error instanceof Error ? error.message : String(error);
	}
	try {
		const object = asObject(parseLenient(stripFence(text)));
		if (object) return { ok: true, value: object, repaired: true };
	} catch {
		// Cai no erro do parse estrito, que é o que o modelo reconhece.
	}
	return { ok: false, error: strictError };
}

export const REPAIRED_ARGS_NOTE = "The arguments were not valid JSON; they were repaired and the call ran. Send strict JSON next time.";
