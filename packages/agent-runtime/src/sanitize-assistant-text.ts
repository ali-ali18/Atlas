/**
 * Alguns modelos (ex.: DeepSeek) emitem o tool-call em um markup próprio
 * (`<|DSML| ...>`, às vezes com pipe full-width `｜` U+FF5C). Removemos esse
 * lixo para não virar mensagem na UI — e se sobrar qualquer vestígio,
 * derrubamos as linhas para o fallback honesto assumir.
 */
// Regex da limpeza de DSML com quantificadores limitados e sem `\s*` colados: texto do modelo pode trazer milhares
// de espaços ou de "<" e um regex polinomial travaria o processo (CodeQL, ReDoS).
const DSML_OPEN_TAG = /<[\s|｜]{0,8}DSML[^<>]{0,500}>/i;
const DSML_CLOSE_TAG = /<[\s|｜]{0,8}\/[\s|｜]{0,8}DSML[^<>]{0,500}>/i;
const DSML_ANY_TAG = /<[\s|｜/]{0,8}DSML[^<>]{0,500}>/gi;
const DSML_LINE_MARK = /<[\s|｜/]{0,8}DSML/i;
const DSML_PIPE_TAIL = /[|｜][ \t]{0,8}DSML[ \t]{0,8}[|｜][^<>\n]{0,500}/gi;
const DSML_INLINE_TAG = /<[^<>\n]{0,500}DSML[^<>\n]{0,500}>/gi;

/** Remove blocos `<DSML ...> ... </DSML>` inteiros (multilinha), um a um, sem regex com `[\s\S]*?`. */
function stripDsmlBlocks(text: string): string {
	let out = "";
	let rest = text;
	for (;;) {
		const open = DSML_OPEN_TAG.exec(rest);
		if (!open) break;
		const afterOpen = rest.slice(open.index + open[0].length);
		const close = DSML_CLOSE_TAG.exec(afterOpen);
		if (!close) break;
		out += rest.slice(0, open.index);
		rest = afterOpen.slice(close.index + close[0].length);
	}
	return out + rest;
}

function trimTrailingBlanks(line: string): string {
	let end = line.length;
	while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
	return line.slice(0, end);
}

/** Aplica a troca até não mudar mais: remover um trecho não pode montar outro (sanitização incompleta). */
function replaceUntilStable(value: string, pattern: RegExp): string {
	let current = value;
	for (let i = 0; i < 20; i++) {
		const next = current.replace(pattern, "");
		if (next === current) return next;
		current = next;
	}
	return current;
}

/**
 * Alguns modelos (ex.: DeepSeek) emitem o tool-call em um markup próprio
 * (`<|DSML| ...>`, às vezes com pipe full-width `｜` U+FF5C). Removemos esse
 * lixo para não virar mensagem na UI — e se sobrar qualquer vestígio,
 * derrubamos as linhas para o fallback honesto assumir.
 */
export function sanitizeAssistantText(text: string): string {
	// Blocos de markup (tool-call vazado, possivelmente multilinha) morrem
	// inteiros: o conteúdo interno é payload de tool, nunca prosa — e linhas
	// órfãs de parâmetro (ex.: "900") não podem vazar para a UI.
	const withoutBlocks = stripDsmlBlocks(text);
	// Linhas de markup solitárias (abertura/fechamento sem par) caem inteiras.
	const withoutMarkupLines = withoutBlocks
		.split("\n")
		.filter((line) => !DSML_LINE_MARK.test(line))
		.join("\n");
	const stripped = replaceUntilStable(replaceUntilStable(withoutMarkupLines, DSML_ANY_TAG), DSML_PIPE_TAIL)
		.replace(/\n{3,}/g, "\n\n")
		.split("\n")
		.map(trimTrailingBlanks)
		.join("\n")
		.trim();
	if (/DSML/i.test(stripped)) {
		// Última rede: remove fragmentos de tag/pipe e derruba linhas sem
		// nenhuma letra (órfãs de markup). Prosa que apenas menciona DSML
		// ("o que é DSML?") sobrevive.
		const kept = stripped
			.split("\n")
			.map((line) => replaceUntilStable(replaceUntilStable(line, DSML_INLINE_TAG), DSML_PIPE_TAIL).trim())
			.filter((line) => /[\p{L}]/u.test(line))
			.join("\n")
			.trim();
		return kept;
	}
	return stripped;
}
