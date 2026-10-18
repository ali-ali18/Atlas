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
