/**
 * Detecta, de forma pura, que um provedor externo (conector MCP, API paga de
 * busca/extração) ficou inutilizável para o resto do run: créditos acabados,
 * cota, rate limit ou chave recusada. Falha de uma página específica (500 do
 * scraper, timeout) NÃO entra aqui: essa o próximo URL pode vencer.
 */

const CREDITS_TEXT =
	/\b402\b|payment required|insufficient credits?|out of credits?|low on credits?|credits? (?:have |has )?(?:run out|been exhausted|exhausted|depleted)|no credits? (?:left|remaining)|quota|billing/i;
const RATE_LIMIT_TEXT = /\b429\b|rate[ -]?limit|too many requests/i;

/** Créditos/cota/cobrança: não melhora sozinho durante o run. */
export function isCreditsExhaustedText(text: string): boolean {
	return CREDITS_TEXT.test(text);
}

/** Créditos, cota ou rate limit. */
export function isProviderExhaustedText(text: string): boolean {
	return CREDITS_TEXT.test(text) || RATE_LIMIT_TEXT.test(text);
}

/** Status HTTP do próprio provedor (não da página alvo) que o deixa fora até o fim do run. */
export function isProviderExhaustedStatus(status: number | undefined): boolean {
	return status === 401 || status === 402 || status === 403 || status === 429;
}
