/**
 * Origens de run sem humano na conversa (rotina, webhook, subagente): não há quem
 * responda a um card de confirmação, então só rodam tools cuja decisão de
 * autonomia é `allow`, e nunca mudam a própria autonomia.
 */
const UNATTENDED_ORIGINS = new Set(["routine", "webhook", "subagent", "proactive"]);

export function isUnattendedOrigin(origin: string | undefined): boolean {
	return origin !== undefined && UNATTENDED_ORIGINS.has(origin);
}
