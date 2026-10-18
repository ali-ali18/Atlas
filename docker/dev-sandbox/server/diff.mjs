// Diff unificado e aplicação de patch sem dependências (o control server roda
// numa imagem enxuta). Linha a linha; prefixo/sufixo comuns são aparados antes
// do LCS para manter o custo baixo em arquivos grandes com edição pequena.

const MAX_LCS_CELLS = 4_000_000;
export const DIFF_CAP_BYTES = 32 * 1024;

function splitLines(text) {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Sequência de operações [" "|"-"|"+", linha]. */
function diffOps(a, b) {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA -= 1;
		endB -= 1;
	}
	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	const ops = [];
	for (let i = 0; i < start; i += 1) ops.push([" ", a[i]]);
	if (midA.length * midB.length > MAX_LCS_CELLS) {
		for (const line of midA) ops.push(["-", line]);
		for (const line of midB) ops.push(["+", line]);
	} else {
		const n = midA.length;
		const m = midB.length;
		const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
		for (let i = n - 1; i >= 0; i -= 1) {
			for (let j = m - 1; j >= 0; j -= 1) {
				table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (midA[i] === midB[j]) {
				ops.push([" ", midA[i]]);
				i += 1;
				j += 1;
			} else if (table[i + 1][j] >= table[i][j + 1]) {
				ops.push(["-", midA[i]]);
				i += 1;
			} else {
				ops.push(["+", midB[j]]);
				j += 1;
			}
		}
		while (i < n) ops.push(["-", midA[i++]]);
		while (j < m) ops.push(["+", midB[j++]]);
	}
	for (let i = endA; i < a.length; i += 1) ops.push([" ", a[i]]);
	return ops;
}

/**
 * Diff unificado (3 linhas de contexto) com contagem de linhas
 * adicionadas/removidas. `diff` é cortado em `cap` bytes com aviso.
 */
export function unifiedDiff(oldText, newText, { path = "arquivo", context = 3, cap = DIFF_CAP_BYTES } = {}) {
	const a = splitLines(oldText);
	const b = splitLines(newText);
	const ops = diffOps(a, b);
	let added = 0;
	let removed = 0;
	for (const [op] of ops) {
		if (op === "+") added += 1;
		else if (op === "-") removed += 1;
	}
	if (added === 0 && removed === 0) return { diff: "", added, removed };

	// Agrupa em hunks com `context` linhas ao redor das mudanças.
	const changeIdx = [];
	ops.forEach(([op], idx) => {
		if (op !== " ") changeIdx.push(idx);
	});
	const ranges = [];
	for (const idx of changeIdx) {
		const from = Math.max(0, idx - context);
		const to = Math.min(ops.length, idx + context + 1);
		const last = ranges[ranges.length - 1];
		if (last && from <= last[1]) last[1] = Math.max(last[1], to);
		else ranges.push([from, to]);
	}
	const lines = [`--- a/${path}`, `+++ b/${path}`];
	for (const [from, to] of ranges) {
		let oldStart = 1;
		let newStart = 1;
		for (let k = 0; k < from; k += 1) {
			if (ops[k][0] !== "+") oldStart += 1;
			if (ops[k][0] !== "-") newStart += 1;
		}
		let oldLen = 0;
		let newLen = 0;
		const body = [];
		for (let k = from; k < to; k += 1) {
			const [op, line] = ops[k];
			if (op !== "+") oldLen += 1;
			if (op !== "-") newLen += 1;
			body.push(`${op}${line}`);
		}
		lines.push(`@@ -${oldLen === 0 ? oldStart - 1 : oldStart},${oldLen} +${newLen === 0 ? newStart - 1 : newStart},${newLen} @@`, ...body);
	}
	let diff = lines.join("\n");
	if (Buffer.byteLength(diff) > cap) {
		diff = `${Buffer.from(diff).subarray(0, cap).toString("utf8").replace(/�+$/, "")}\n[... diff cortado ...]`;
	}
	return { diff, added, removed };
}

/**
 * Aplica um diff unificado (um arquivo). Exige que o contexto/linhas removidas
 * batam EXATAMENTE (com tolerância de deslocamento de até 200 linhas, como o
 * `patch`). Lança Error com mensagem clara quando um hunk não encaixa.
 */
export function applyUnifiedDiff(original, patchText) {
	const src = splitLines(original);
	const endsWithNewline = original === "" || original.endsWith("\n");
	const patchLines = patchText.replace(/\r\n/g, "\n").split("\n");
	const hunks = [];
	let current = null;
	for (const line of patchLines) {
		const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (header) {
			current = { oldStart: Number(header[1]), lines: [] };
			hunks.push(current);
			continue;
		}
		if (!current) continue; // cabeçalhos ---/+++ e texto solto
		if (line.startsWith("\\")) continue; // "\ No newline at end of file"
		const op = line[0];
		if (op === " " || op === "-" || op === "+") current.lines.push([op, line.slice(1)]);
		else if (line === "") current.lines.push([" ", ""]);
	}
	if (hunks.length === 0) throw new Error("Patch sem hunks (@@ ... @@)");

	const out = [];
	let cursor = 0; // próxima linha de `src` ainda não copiada
	for (const hunk of hunks) {
		const expected = hunk.lines.filter(([op]) => op !== "+").map(([, text]) => text);
		const guess = Math.max(cursor, hunk.oldStart - 1);
		let found = -1;
		for (let delta = 0; delta <= 200 && found < 0; delta += 1) {
			for (const pos of delta === 0 ? [guess] : [guess + delta, guess - delta]) {
				if (pos < cursor || pos + expected.length > src.length) continue;
				if (expected.every((text, k) => src[pos + k] === text)) {
					found = pos;
					break;
				}
			}
		}
		if (found < 0) {
			throw new Error(`Hunk @@ -${hunk.oldStart} não encaixa: o arquivo mudou ou o contexto está errado`);
		}
		out.push(...src.slice(cursor, found));
		for (const [op, text] of hunk.lines) if (op !== "-") out.push(text);
		cursor = found + expected.length;
	}
	out.push(...src.slice(cursor));
	return out.length ? out.join("\n") + (endsWithNewline ? "\n" : "") : "";
}
