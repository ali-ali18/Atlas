// Casamento em camadas para edit_file (modo old/new): exato → CRLF/LF → espaço no fim da linha →
// indentação flexível. Porta a ideia do fuzzy_match do Hermes: o modelo erra espaço/indentação com
// frequência, e falhar por isso só gasta turnos. Qualquer ambiguidade (mais de uma ocorrência) é
// rejeitada pelo chamador; aqui só se acha e se calcula o trecho a trocar.

export const MAX_LISTED_LINES = 5;

function splitLines(text) {
	// Cada linha guarda onde começa, onde termina o conteúdo e onde termina o terminador.
	const lines = [];
	let start = 0;
	while (start < text.length) {
		const nl = text.indexOf("\n", start);
		const end = nl === -1 ? text.length : nl;
		const contentEnd = end > start && text[end - 1] === "\r" ? end - 1 : end;
		lines.push({ text: text.slice(start, contentEnd), start, contentEnd, end: nl === -1 ? end : end + 1, crlf: contentEnd !== end });
		if (nl === -1) break;
		start = nl + 1;
	}
	return lines;
}

const STRATEGIES = [
	{ name: "crlf", note: "quebras de linha CRLF/LF ajustadas", same: (a, b) => a === b },
	{ name: "trailing", note: "espaços no fim das linhas ignorados", same: (a, b) => a.trimEnd() === b.trimEnd() },
	{ name: "indent", note: "indentação ajustada", same: (a, b) => a.trim() === b.trim() },
];

/** Posições (linha 1-based) de cada ocorrência exata de `needle`. */
function exactMatches(text, needle) {
	const hits = [];
	let from = 0;
	for (;;) {
		const at = text.indexOf(needle, from);
		if (at === -1) break;
		hits.push({ start: at, end: at + needle.length });
		from = at + Math.max(1, needle.length);
	}
	return hits;
}

export function lineOf(text, offset) {
	let line = 1;
	for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) line += 1;
	return line;
}

function leadingIndent(line) {
	return /^[ \t]*/.exec(line)[0];
}

/** Reindenta `newText` somando a diferença entre a indentação do trecho achado e a do `old`. */
function reindent(newText, oldIndent, foundIndent) {
	if (oldIndent === foundIndent) return newText;
	return newText
		.split("\n")
		.map((line) => (line.trim() === "" || !line.startsWith(oldIndent) ? line : foundIndent + line.slice(oldIndent.length)))
		.join("\n");
}

/**
 * Procura `oldText` em `text`. Devolve `{ strategy, matches }`, cada match com `start`, `end`
 * (offsets no texto original), `line` (1-based) e `replacement` (o `newText` já adaptado ao trecho).
 */
export function findMatches(text, oldText, newText) {
	const exact = exactMatches(text, oldText);
	if (exact.length) {
		return { strategy: "exact", note: null, matches: exact.map((m) => ({ ...m, line: lineOf(text, m.start), replacement: newText })) };
	}
	const oldNorm = oldText.replaceAll("\r\n", "\n");
	const newNorm = newText.replaceAll("\r\n", "\n");
	const wantsTrailingNewline = oldNorm.endsWith("\n");
	const oldLines = oldNorm.replace(/\n$/, "").split("\n");
	const fileLines = splitLines(text);
	for (const strategy of STRATEGIES) {
		const matches = [];
		for (let i = 0; i + oldLines.length <= fileLines.length; i += 1) {
			if (!oldLines.every((line, k) => strategy.same(fileLines[i + k].text, line))) continue;
			const first = fileLines[i];
			const last = fileLines[i + oldLines.length - 1];
			const crlf = fileLines.slice(i, i + oldLines.length).some((l) => l.crlf);
			let replacement = newNorm;
			if (strategy.name === "indent") {
				const k = oldLines.findIndex((l) => l.trim() !== "");
				if (k !== -1) replacement = reindent(newNorm, leadingIndent(oldLines[k]), leadingIndent(fileLines[i + k].text));
			}
			if (crlf) replacement = replacement.replaceAll("\n", "\r\n");
			matches.push({ start: first.start, end: wantsTrailingNewline ? last.end : last.contentEnd, line: i + 1, replacement });
		}
		if (matches.length) return { strategy: strategy.name, note: strategy.note, matches };
	}
	return { strategy: null, note: null, matches: [] };
}

/** Aplica os matches (em ordem crescente, sem sobreposição) ao texto. */
export function applyMatches(text, matches) {
	let out = "";
	let cursor = 0;
	for (const m of matches) {
		out += text.slice(cursor, m.start) + m.replacement;
		cursor = m.end;
	}
	return out + text.slice(cursor);
}

export function listLines(matches) {
	const lines = matches.slice(0, MAX_LISTED_LINES).map((m) => m.line);
	return lines.join(", ") + (matches.length > MAX_LISTED_LINES ? ", …" : "");
}

const SIMILAR_MAX_REGIONS = 3;
const SIMILAR_CONTEXT = 2;
const SIMILAR_MIN_SCORE = 0.5;
export const SIMILAR_MAX_CHARS = 1500;

function bigrams(text) {
	const grams = new Map();
	for (let i = 0; i < text.length - 1; i += 1) {
		const gram = text.slice(i, i + 2);
		grams.set(gram, (grams.get(gram) ?? 0) + 1);
	}
	return grams;
}

/** Similaridade de Dice por bigramas, 0..1. Barata e boa o bastante para achar a linha "quase igual". */
function lineSimilarity(a, b) {
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return 0;
	const ga = bigrams(a);
	const gb = bigrams(b);
	let shared = 0;
	for (const [gram, n] of ga) shared += Math.min(n, gb.get(gram) ?? 0);
	return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/**
 * Até 3 regiões do arquivo mais parecidas com as primeiras linhas não vazias de `oldText`, com
 * número de linha e 2 linhas de contexto. Texto pronto para entrar no erro ("" se nada se parece).
 */
export function describeSimilarRegions(text, oldText) {
	const wanted = oldText.replaceAll("\r\n", "\n").split("\n").map((l) => l.trim());
	while (wanted.length && wanted[0] === "") wanted.shift();
	const probe = wanted.slice(0, 3);
	if (!probe.length || probe.every((l) => l === "")) return "";
	const fileLines = text.replaceAll("\r\n", "\n").split("\n");
	const scored = [];
	for (let i = 0; i < fileLines.length; i += 1) {
		let total = 0;
		for (let k = 0; k < probe.length; k += 1) total += lineSimilarity(probe[k], (fileLines[i + k] ?? "").trim());
		scored.push({ i, score: total / probe.length });
	}
	scored.sort((a, b) => b.score - a.score || a.i - b.i);
	const picked = [];
	for (const candidate of scored) {
		if (candidate.score < SIMILAR_MIN_SCORE || picked.length >= SIMILAR_MAX_REGIONS) break;
		if (picked.some((p) => Math.abs(p.i - candidate.i) <= probe.length + SIMILAR_CONTEXT)) continue;
		picked.push(candidate);
	}
	if (!picked.length) return "";
	picked.sort((a, b) => a.i - b.i);
	const blocks = picked.map(({ i }) => {
		const from = Math.max(0, i - SIMILAR_CONTEXT);
		const to = Math.min(fileLines.length, i + probe.length + SIMILAR_CONTEXT);
		const body = fileLines.slice(from, to).map((line, k) => `${String(from + k + 1).padStart(5)}| ${line.length > 160 ? `${line.slice(0, 160)}…` : line}`);
		return `Perto da linha ${i + 1}:\n${body.join("\n")}`;
	});
	let out = `Trechos parecidos:\n${blocks.join("\n")}`;
	if (out.length > SIMILAR_MAX_CHARS) out = `${out.slice(0, SIMILAR_MAX_CHARS)}…`;
	return out;
}

export const EXCERPT_CONTEXT = 3;
export const EXCERPT_MAX_LINES = 40;

function toLines(text) {
	const lines = text.replaceAll("\r\n", "\n").split("\n");
	if (lines.length && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/**
 * Janela do que mudou entre `before` e `after` (±3 linhas, no máximo 40), para o modelo conferir a
 * edição sem reler o arquivo. `firstLine` é 1-based.
 */
export function editedExcerpt(before, after) {
	const a = toLines(before);
	const b = toLines(after);
	if (!b.length) return null;
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
	let suffix = 0;
	while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
	const from = Math.max(0, prefix - EXCERPT_CONTEXT);
	let to = Math.min(b.length, Math.max(prefix, b.length - suffix) + EXCERPT_CONTEXT);
	if (to - from > EXCERPT_MAX_LINES) to = from + EXCERPT_MAX_LINES;
	if (to <= from) return null;
	return { firstLine: from + 1, text: b.slice(from, to).join("\n") };
}
