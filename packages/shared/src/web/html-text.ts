// Funções puras de texto HTML usadas pela busca nativa (v2 e v4 compartilham): decodificar entidades e tirar tags.

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	hellip: "…",
	laquo: "«",
	raquo: "»",
	copy: "©",
	reg: "®",
	euro: "€",
};

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
		if (code[0] === "#") {
			const value = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
			return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : match;
		}
		return ENTITIES[code.toLowerCase()] ?? match;
	});
}

export const INLINE_TAGS = /<\/?(b|i|u|em|strong|span|small|mark|sup|sub|abbr|code|s|a)\b[^>]*>/gi;

export function stripTags(html: string): string {
	return decodeEntities(html.replace(INLINE_TAGS, "").replace(/<[^>]+>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}
