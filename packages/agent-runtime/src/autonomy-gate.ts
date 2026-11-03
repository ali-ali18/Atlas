/**
 * Origens de run sem humano na conversa (rotina, webhook, subagente): não há quem
 * responda a um card de confirmação, então só rodam tools cuja decisão de
 * autonomia é `allow`, e nunca mudam a própria autonomia.
 */
const UNATTENDED_ORIGINS = new Set(["routine", "webhook", "subagent", "proactive"]);

export function isUnattendedOrigin(origin: string | undefined): boolean {
	return origin !== undefined && UNATTENDED_ORIGINS.has(origin);
}

/**
 * Origens em que ninguém está na conversa para aprovar uma escrita de conector: as
 * sem humano (rotina, webhook, proativo) mais o e-mail que chega na caixa do bot e o
 * pedido vindo de outro bot (decisão do dono, 03/11). `subagent` fica de fora: é filho
 * de um chat com humano. Nessas origens o conector só entrega tools de leitura,
 * em qualquer nível de autonomia.
 */
const READ_ONLY_CONNECTOR_ORIGINS = new Set(["routine", "webhook", "proactive", "email", "bot"]);

export function isReadOnlyConnectorOrigin(origin: string | undefined): boolean {
	return origin !== undefined && READ_ONLY_CONNECTOR_ORIGINS.has(origin);
}
