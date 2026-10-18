/**
 * Alguns modelos (ex.: DeepSeek) vazam o tool-call como markup próprio
 * (`<|DSML| ...>`, às vezes com pipe full-width `｜` U+FF5C). Mesmo padrão
 * do runtime (`packages/agent-runtime`): blocos morrem inteiros, linhas
 * solitárias caem, prosa que só menciona DSML sobrevive.
 */
export function sanitizeAssistantText(
	text: string,
	options?: { live?: boolean },
): string {
	const withoutBlocks = text.replace(
		/<\s*[|｜]?\s*DSML\s*[|｜]?[^>]*>[\s\S]*?<\s*\/\s*[|｜]?\s*DSML\s*[|｜]?[^>]*>/gi,
		"",
	);
	const withoutMarkupLines = withoutBlocks
		.split("\n")
		.filter((line) => !/<\/?\s*[|｜]?\s*DSML/i.test(line))
		.join("\n");
	const cleaned = withoutMarkupLines
		.replace(/<\/?\s*[|｜]?\s*DSML\s*[|｜]?[^>]*>/gi, "")
		.replace(/[|｜]\s*DSML\s*[|｜][^<>\n]*/gi, "")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]+\n/g, "\n");
	const withoutRemnants = /DSML/i.test(cleaned)
		? cleaned
				.split("\n")
				.map((line) =>
					line
						.replace(/<[^<>\n]*DSML[^<>\n]*>/gi, "")
						.replace(/[|｜]\s*DSML\s*[|｜][^<>\n]*/gi, "")
						.trim(),
				)
				.filter((line) => /[\p{L}]/u.test(line))
				.join("\n")
				.trim()
		: cleaned.trim();
	return options?.live
		? withoutRemnants.replace(/^\s+/, "")
		: withoutRemnants;
}
