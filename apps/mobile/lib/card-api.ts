// Resolução dos cartões de proposta: os mesmos endpoints do web (`resolveBotProposal` e `resolveBotProfileProposal` em
// `apps/web/lib/atlas-api.ts`), sempre por `apiFetch`. O servidor só resolve proposta de conversa do dono da sessão
// (de outro dono: 404).
import { ChatApiError, json } from "./chat-api";
import type { ApiFetch } from "./home-sync";

export type ResolveDecision = "approved" | "rejected";

export type BotProposalResult = { status: ResolveDecision; name: string; botId: string | null; unchanged: boolean; warnings: string[] };
export type BotProfileResult = { status: ResolveDecision; fields: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const unexpected = () => new ChatApiError("Resposta inesperada do servidor.", 502);

/** `POST /v1/cards/bot-proposal/resolve`: aprovar cria o bot (uma vez só; repetir devolve o mesmo, `unchanged`). */
export async function resolveBotProposal(apiFetch: ApiFetch, input: { conversationId: string; proposalId: string; decision: ResolveDecision }): Promise<BotProposalResult> {
	const body = await json<unknown>(apiFetch, "/v1/cards/bot-proposal/resolve", { method: "POST", body: JSON.stringify({ conversationId: input.conversationId, proposalId: input.proposalId, decision: input.decision }) });
	if (!isRecord(body) || body.ok !== true || (body.status !== "approved" && body.status !== "rejected") || typeof body.name !== "string") throw unexpected();
	return {
		status: body.status,
		name: body.name,
		botId: typeof body.botId === "string" && body.botId ? body.botId : null,
		unchanged: body.unchanged === true,
		warnings: Array.isArray(body.warnings) ? body.warnings.filter((item): item is string => typeof item === "string") : [],
	};
}

/** `POST /v1/cards/bot-profile/resolve`: aprovar aplica o perfil proposto no bot; recusar só marca. */
export async function resolveBotProfile(apiFetch: ApiFetch, input: { conversationId: string; proposalId: string; decision: ResolveDecision }): Promise<BotProfileResult> {
	const body = await json<unknown>(apiFetch, "/v1/cards/bot-profile/resolve", { method: "POST", body: JSON.stringify({ conversationId: input.conversationId, proposalId: input.proposalId, decision: input.decision }) });
	if (!isRecord(body) || body.ok !== true || (body.status !== "approved" && body.status !== "rejected")) throw unexpected();
	return { status: body.status, fields: Array.isArray(body.fields) ? body.fields.filter((item): item is string => typeof item === "string") : [] };
}

/** Frase simples para a falha de um cartão de proposta (sem texto técnico). */
export function proposalErrorText(error: unknown, decision: ResolveDecision, action: "bot" | "profile"): string {
	if (error instanceof ChatApiError) {
		if (error.status === 401) return "Sua sessão expirou. Entre de novo.";
		if (error.status === 404) return "Esta proposta não existe mais.";
		if (error.status === 409) return "Esta proposta já foi recusada.";
		if (decision === "rejected") return "Não consegui dispensar agora. Tente de novo.";
		return action === "bot" ? "Não consegui criar o agente. Tente de novo." : "Não consegui aplicar agora. Tente de novo.";
	}
	return "Sem conexão com o seu servidor. Tente de novo.";
}
