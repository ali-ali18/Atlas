// Validade do link da tela ao vivo. O servidor assina o link por 10 minutos (e o noVNC com `reconnect` recebe 401 em
// laço depois disso), então o app pede um novo ANTES de vencer e quando a conexão cai. Tudo puro, com `now` injetado.

/** Quanto o link vale no servidor. */
export const LINK_TTL_MS = 10 * 60_000;
/** Renova com folga: a WebView recarrega com link novo aos 8 min. */
export const LINK_RENEW_MS = 8 * 60_000;
/** Intervalo mínimo entre renovações por queda de conexão (evita laço quando o servidor está fora). */
export const DROP_RENEW_GAP_MS = 5_000;
/** Espera para tentar de novo quando a renovação falha. */
export const RENEW_RETRY_MS = 15_000;

/** Em quantos ms renovar um link emitido em `issuedAt` (0 se já passou da hora). */
export function renewDelayMs(issuedAt: number, now: number): number {
	return Math.max(0, issuedAt + LINK_RENEW_MS - now);
}

/** O link já passou da hora de renovar. */
export function shouldRenew(issuedAt: number, now: number): boolean {
	return renewDelayMs(issuedAt, now) === 0;
}

/** O link já venceu no servidor (não adianta recarregar a WebView com ele). */
export function isLinkExpired(issuedAt: number, now: number): boolean {
	return now - issuedAt >= LINK_TTL_MS;
}

/** A conexão caiu: renova agora, a não ser que acabou de renovar (`lastRenewAt` é o último emitido ou tentado). */
export function canRenewAfterDrop(lastRenewAt: number, now: number): boolean {
	return now - lastRenewAt >= DROP_RENEW_GAP_MS;
}
