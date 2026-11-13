// Casamento de `code_edit` para o FAKE da porta `Sandbox` (testes e evals). A fonte da verdade é a da VM
// (`docker/dev-sandbox/server/edit-match.mjs`, que roda dentro do container e não importa de `shared`): este arquivo é um porte do
// núcleo (exato → CRLF → espaço no fim → indentação), e `code-edit-match.parity.test.ts` roda a MESMA tabela de casos nos dois
// para a cópia não divergir em silêncio. Não use em produção: lá a VM edita.
export type EditMatch = { start: number; end: number; line: number; replacement: string };
export type EditFound = { strategy: "exact" | "crlf" | "trailing" | "indent" | null; note: string | null; matches: EditMatch[] };

type Line = { doc: string; start: number; contentEnd: number; end: number; crlf: boolean };

function splitLines(doc: string): Line[] {
	const lines: Line[] = [];
	let start = 0;
	while (start < doc.length) {
		const nl = doc.indexOf("\n", start);
		const end = nl === -1 ? doc.length : nl;
		const contentEnd = end > start && doc[end - 1] === "\r" ? end - 1 : end;
		lines.push({ doc: doc.slice(start, contentEnd), start, contentEnd, end: nl === -1 ? end : end + 1, crlf: contentEnd !== end });
		if (nl === -1) break;
		start = nl + 1;
	}
	return lines;
}

const STRATEGIES = [
	{ name: "crlf", note: "quebras de linha CRLF/LF ajustadas", same: (a: string, b: string) => a === b },
	{ name: "trailing", note: "espaços no fim das linhas ignorados", same: (a: string, b: string) => a.trimEnd() === b.trimEnd() },
	{ name: "indent", note: "indentação ajustada", same: (a: string, b: string) => a.trim() === b.trim() },
] as const;

export function lineOf(doc: string, offset: number): number {
	let line = 1;
	for (let i = doc.indexOf("\n"); i !== -1 && i < offset; i = doc.indexOf("\n", i + 1)) line += 1;
	return line;
}

const leadingIndent = (line: string): string => /^[ \t]*/.exec(line)?.[0] ?? "";

function reindent(newText: string, oldIndent: string, foundIndent: string): string {
	if (oldIndent === foundIndent) return newText;
	return newText
		.split("\n")
		.map((line) => (line.trim() === "" || !line.startsWith(oldIndent) ? line : foundIndent + line.slice(oldIndent.length)))
		.join("\n");
}

export function findMatches(doc: string, oldText: string, newText: string): EditFound {
	const exact: Array<{ start: number; end: number }> = [];
	for (let from = 0; ; ) {
		const at = doc.indexOf(oldText, from);
		if (at === -1) break;
		exact.push({ start: at, end: at + oldText.length });
		from = at + Math.max(1, oldText.length);
	}
	if (exact.length) {
		const growsInCrlf = (m: { end: number }): boolean => {
			if (oldText.includes("\n") || !/[^\r]\n|^\n/.test(newText)) return false;
			const nl = doc.indexOf("\n", m.end);
			return nl > 0 && doc[nl - 1] === "\r";
		};
		return { strategy: "exact", note: null, matches: exact.map((m) => ({ ...m, line: lineOf(doc, m.start), replacement: growsInCrlf(m) ? newText.replace(/\r?\n/g, "\r\n") : newText })) };
	}
	const oldNorm = oldText.replaceAll("\r\n", "\n");
	const newNorm = newText.replaceAll("\r\n", "\n");
	const wantsTrailingNewline = oldNorm.endsWith("\n");
	const oldLines = oldNorm.replace(/\n$/, "").split("\n");
	const fileLines = splitLines(doc);
	for (const strategy of STRATEGIES) {
		const matches: EditMatch[] = [];
		for (let i = 0; i + oldLines.length <= fileLines.length; i += 1) {
			if (!oldLines.every((line, k) => strategy.same((fileLines[i + k] as Line).doc, line))) continue;
			const first = fileLines[i] as Line;
			const last = fileLines[i + oldLines.length - 1] as Line;
			const crlf = fileLines.slice(i, i + oldLines.length).some((l) => l.crlf);
			let replacement = newNorm;
			if (strategy.name === "indent") {
				const k = oldLines.findIndex((l) => l.trim() !== "");
				if (k !== -1) replacement = reindent(newNorm, leadingIndent(oldLines[k] as string), leadingIndent((fileLines[i + k] as Line).doc));
			}
			if (crlf) replacement = replacement.replaceAll("\n", "\r\n");
			matches.push({ start: first.start, end: wantsTrailingNewline ? last.end : last.contentEnd, line: i + 1, replacement });
		}
		if (matches.length) return { strategy: strategy.name, note: strategy.note, matches };
	}
	return { strategy: null, note: null, matches: [] };
}

export function applyMatches(doc: string, matches: readonly EditMatch[]): string {
	let out = "";
	let cursor = 0;
	for (const m of matches) {
		out += doc.slice(cursor, m.start) + m.replacement;
		cursor = m.end;
	}
	return out + doc.slice(cursor);
}

export type EditOutcome = { ok: true; text: string; note: string | null } | { ok: false; error: string };

/** As mesmas recusas do `patch` da VM: não achou, ambíguo sem replaceAll, replaceAll sem casamento exato. */
export function applyEdit(doc: string, oldText: string, newText: string, replaceAll = false): EditOutcome {
	if (oldText === "") return { ok: false, error: "old não pode ser vazio (use write para criar/substituir o arquivo)" };
	if (oldText === newText) return { ok: false, error: "old e new são iguais; nada a mudar" };
	const found = findMatches(doc, oldText, newText);
	if (found.matches.length === 0) return { ok: false, error: "old não foi encontrado no arquivo. Leia o trecho atual (read_file) e copie o texto, com a indentação." };
	if (found.strategy !== "exact" && replaceAll) return { ok: false, error: "replace_all só vale quando old casa exatamente (aqui só casou com ajuste de espaço/indentação); copie o texto exato ou edite uma ocorrência por vez" };
	if (found.matches.length > 1 && !replaceAll) {
		const lines = found.matches.slice(0, 5).map((m) => m.line).join(", ") + (found.matches.length > 5 ? ", …" : "");
		return { ok: false, error: `old aparece ${found.matches.length} vezes (linhas ${lines}); inclua mais contexto para torná-lo único (ou use replace_all)` };
	}
	return { ok: true, text: applyMatches(doc, replaceAll ? found.matches : found.matches.slice(0, 1)), note: found.note };
}
