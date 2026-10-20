/**
 * Flag da economia de contexto (`ATLAS_CONTEXT_ECONOMY`): tools nativas raras
 * adiadas, procedimentos do prompt por intenção e resultado grande por
 * referência. Padrão: ligada. `off`/`0`/`false` restaura o comportamento anterior.
 */
export function contextEconomyEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	const raw = env.ATLAS_CONTEXT_ECONOMY?.trim().toLowerCase();
	return !(raw === "off" || raw === "0" || raw === "false");
}

/**
 * Flag da conversa contínua (`ATLAS_CONTEXT_TRANSCRIPT`): o run novo de uma conversa parte da conversa completa do
 * anterior (chamadas e resultados de ferramenta), a aprovação continua o mesmo laço e as tools já usadas seguem
 * carregadas. Padrão: ligada. `off`/`0`/`false` restaura o histórico só de texto.
 */
export function contextTranscriptEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	const raw = env.ATLAS_CONTEXT_TRANSCRIPT?.trim().toLowerCase();
	return !(raw === "off" || raw === "0" || raw === "false");
}
