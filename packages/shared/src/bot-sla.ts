/**
 * Prazo de resposta entre bots (`send_to_bot`): pedido pendente ou entregue sem resposta não fica em
 * aberto para sempre sem ninguém saber. Regras puras: o worker decide com elas quando marcar o
 * pedido como atrasado na conversa do remetente, e o runtime mostra ao remetente o que segue em aberto.
 */

/** Depois disso sem resposta, o pedido aparece como atrasado para o usuário. */
export const BOT_REPLY_SLA_MS = 30 * 60_000;
/** Pedidos mais velhos que isso não entram no bloco do prompt (a conversa já seguiu). */
export const OPEN_BOT_REQUESTS_WINDOW_MS = 24 * 60 * 60_000;
export const OPEN_BOT_REQUESTS_MAX = 5;

/** Estados de um `BotMessage` em que o remetente ainda espera a resposta do destino. */
export const OPEN_BOT_REQUEST_STATUSES = ["pending", "delivering", "delivered", "waiting"] as const;

export function isOpenBotRequestStatus(status: string): boolean {
	return (OPEN_BOT_REQUEST_STATUSES as readonly string[]).includes(status);
}

/** Atrasado = ainda em aberto e sem resposta depois do prazo. */
export function isBotRequestOverdue(input: { status: string; createdAt: Date }, now: Date, slaMs = BOT_REPLY_SLA_MS): boolean {
	return isOpenBotRequestStatus(input.status) && now.getTime() - input.createdAt.getTime() >= slaMs;
}

/** Linha que o usuário vê no marcador "Enviou mensagem para X" (pt-BR). */
export function botOverdueLabel(botName: string, status: string): string {
	return status === "pending" || status === "delivering"
		? `${botName} ainda não recebeu o pedido`
		: `${botName} ainda não respondeu`;
}

export type OpenBotRequest = { botName: string; title: string; status: string; createdAt: Date };

const ageText = (ms: number) => {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
};
const clip = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * Bloco curto (inglês, voltado ao modelo) com os pedidos a outros bots ainda sem resposta. Null sem
 * nenhum. O modelo não inventa o resultado do outro bot e diz a verdade se o usuário perguntar.
 */
export function formatOpenBotRequests(requests: readonly OpenBotRequest[], now: Date): string | null {
	const open = requests
		.filter((request) => isOpenBotRequestStatus(request.status) && now.getTime() - request.createdAt.getTime() < OPEN_BOT_REQUESTS_WINDOW_MS)
		.slice(0, OPEN_BOT_REQUESTS_MAX);
	if (open.length === 0) return null;
	const lines = open.map((request) => {
		const age = now.getTime() - request.createdAt.getTime();
		const late = age >= BOT_REPLY_SLA_MS ? ", overdue" : "";
		return `- ${clip(request.botName, 40)}: "${clip(request.title, 80)}" (sent ${ageText(age)} ago, no reply yet${late})`;
	});
	return [
		"[open_bot_requests] You asked these bots and have no reply yet:",
		...lines,
		"Their answer arrives later in this conversation. Do not present their result as done; if the user asks, say it is still pending (and overdue when marked).",
	].join("\n");
}
