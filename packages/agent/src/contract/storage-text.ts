// Sanitização de FORMATO do que a tool devolve, antes de gravar (checkpoint jsonb, notas de texto, journal).
// O Postgres recusa `\u0000` em text/jsonb e recusa substituto UTF-16 solto em jsonb; um byte assim numa
// saída de tool derrubaria o checkpoint do run inteiro. Troca determinística por U+FFFD (caractere de
// substituição); o resto do texto passa byte a byte. Não é decisão de comportamento nem corte de conteúdo.
const INVALID = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function storageSafe(text: string): string {
	return text.replace(INVALID, "�");
}
