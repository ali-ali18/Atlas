/**
 * Conversa entre bots: quando o run do bot de destino espera o usuário (login,
 * captcha, aprovação...), o pedido é relayado ao remetente. Regras puras:
 * reconhece o card pendente da conversa do destino e o transforma num `BotNeed`.
 */
import type { BotNeed } from "./bot-messaging.js";
import { buildBotPendingItem, type PendingIntentHint } from "./bot-pending.js";
import { parseConversationCard } from "./skill-card.js";
import { parseSkillProposalCard } from "./skill-proposal.js";

/** Roles de card da conversa do destino que podem esperar o usuário. */
export const BOT_NEED_CARD_ROLES = ["login", "confirm", "bot-profile", "questionnaire", "skill-proposal"] as const;

const oneLine = (value: string, max: number): string => value.replace(/\s+/g, " ").trim().slice(0, max);

/** O texto do motivo, no imperativo curto, sem nome do bot. */
export function needLabel(need: Pick<BotNeed, "type" | "site" | "confirmTitle">, fallbackTitle = ""): string {
	switch (need.type) {
		case "login":
			return `Fazer login em ${need.site ?? "um site"}`;
		case "captcha":
			return `Resolver a verificação (captcha) em ${need.site ?? "um site"}`;
		case "connector":
			return `Conectar ${need.site ?? "um app"}`;
		case "confirm":
			return `Aprovar: ${need.confirmTitle ?? fallbackTitle}`;
		case "profile":
			return "Aprovar a mudança no perfil do bot";
		default:
			return fallbackTitle ? `Responder: ${fallbackTitle}` : "Responder uma pergunta";
	}
}

/**
 * Card persistido (role + conteúdo) que ainda espera o usuário → `BotNeed`.
 * `null` = não é um card pendente (ou o tipo não espera ação humana).
 * `runId` do destino só vale para login (o run pausado é retomado por ele).
 */
export function needFromCardRow(input: {
	rowId: string;
	conversationId: string;
	role: string;
	content: string;
	targetRunId?: string | null;
	/** Intenção pendente do destino (tipo da ação MCP etc.); sem ela o item é conservador. */
	intent?: PendingIntentHint | null;
}): BotNeed | null {
	const need = needFromCardRowBase(input);
	if (!need) return null;
	// Login/captcha/conector têm card próprio e só o usuário resolve: ficam sem item estruturado.
	if (need.type === "login" || need.type === "captcha" || need.type === "connector") return need;
	const item = buildBotPendingItem({ rowId: input.rowId, role: input.role, content: input.content, intent: input.intent });
	return item ? { ...need, item } : need;
}

function needFromCardRowBase(input: {
	rowId: string;
	conversationId: string;
	role: string;
	content: string;
	targetRunId?: string | null;
}): BotNeed | null {
	const base = { cardId: input.rowId, conversationId: input.conversationId };
	if (input.role === "skill-proposal") {
		const proposal = parseSkillProposalCard(input.content);
		if (!proposal || proposal.status !== "pending") return null;
		return { ...base, type: "other", label: `Aprovar skill: ${oneLine(proposal.name, 80)}` };
	}
	const card = parseConversationCard(input.content);
	if (!card) return null;
	if (card.kind === "login") {
		if (card.status !== "pending") return null;
		const connector = card.connector;
		const type = connector ? "connector" : card.reason === "captcha" ? "captcha" : "login";
		const site = connector ? connector.name : card.site;
		const runId = card.runId ?? input.targetRunId ?? undefined;
		const need: BotNeed = { ...base, type, label: "", site, ...(runId ? { runId } : {}) };
		return { ...need, label: needLabel(need) };
	}
	if (card.kind === "confirm") {
		if (card.status !== "pending") return null;
		const need: BotNeed = {
			...base,
			type: "confirm",
			label: "",
			confirmTitle: oneLine(card.title, 160),
			...(card.confirmLabel ? { confirmLabel: card.confirmLabel } : {}),
			...(card.cancelLabel ? { cancelLabel: card.cancelLabel } : {}),
		};
		return { ...need, label: needLabel(need) };
	}
	if (card.kind === "bot-profile") {
		if (card.status !== "pending") return null;
		return { ...base, type: "profile", label: needLabel({ type: "profile" }), proposalId: card.proposalId };
	}
	if (card.kind === "questionnaire") {
		if (card.status !== "pending") return null;
		return { ...base, type: "other", label: `Responder: ${oneLine(card.title, 120)}` };
	}
	return null;
}
