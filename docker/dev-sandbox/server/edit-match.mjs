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
