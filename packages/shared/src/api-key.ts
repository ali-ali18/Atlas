/** Chave plausível: sem espaços/controles, tamanho razoável. Nunca devolve nem registra o valor. */
export function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const key = value.trim();
	// eslint-disable-next-line no-control-regex
	if (key.length < 8 || key.length > 512 || /[\s\u0000-\u001f\u007f]/.test(key)) return null;
	return key;
}
