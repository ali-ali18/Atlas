import { Hono } from "hono";
import { getOwnedConversation, getPendingBotProposal, resolveBotProposal } from "@workspace/db";
import { parseBotProposalEdits } from "@workspace/shared";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import { validateProviderModel, type ModelValidation } from "../providers/model-catalog.js";

/**
 * Gate humano da proposta de novo agente. O que é criado é o que está GRAVADO no
 * card da conversa do dono; o corpo só diz qual proposta, a decisão e (opcional)
 * nome/papel revisados. Conversa ou proposta de outro dono = 404. Aprovar duas
 * vezes devolve o mesmo resultado, sem criar outro bot.
 */
const NOT_FOUND = { error: "Proposta não encontrada." } as const;

export type BotProposalRouteDeps = {
	resolve?: typeof resolveBotProposal;
	validateModel?: (userId: string, model: string) => Promise<ModelValidation>;
};

export function createBotProposalRoutes(deps: BotProposalRouteDeps = {}) {
	const resolve = deps.resolve ?? resolveBotProposal;
	const validateModel = deps.validateModel ?? validateProviderModel;
	const app = new Hono<AuthEnv>();

	/** POST /v1/cards/bot-proposal/resolve — `{ conversationId, proposalId, decision, edits? }`. */
	app.post("/v1/cards/bot-proposal/resolve", async (c) => {
		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
		const conversationId = typeof body?.conversationId === "string" ? body.conversationId.trim() : "";
		const proposalId = typeof body?.proposalId === "string" ? body.proposalId.trim() : "";
		const decision = body?.decision;
		if (!conversationId || !proposalId || (decision !== "approved" && decision !== "rejected")) {
			return c.json({ error: 'Corpo inválido: esperado { conversationId, proposalId, decision: "approved" | "rejected" }.' }, 400);
		}
		const edits = parseBotProposalEdits(body?.edits);
		if (!edits) return c.json({ error: "Nome ou papel inválido." }, 400);
		try {
			const { userId } = scopeFor(c.get("session"));
			if (!(await getOwnedConversation(conversationId, userId))) return c.json(NOT_FOUND, 404);
			let model: string | null | undefined;
			let modelNote: string | undefined;
			if (decision === "approved") {
				const pending = await getPendingBotProposal(conversationId, proposalId);
				if (pending?.model) {
					// Modelo que a conta não pode usar não trava a criação: cai no padrão.
					const validation = await validateModel(userId, pending.model).catch(() => ({ error: "indisponível", status: 503 as const }));
					if ("error" in validation) {
						model = null;
						modelNote = "O modelo sugerido não está disponível; usei o padrão.";
					}
				}
			}
			const result = await resolve({ userId, conversationId, proposalId, decision, edits, ...(model !== undefined ? { model } : {}) });
			if (!result.ok) return c.json({ error: result.error }, result.status);
			const warnings = [...(modelNote ? [modelNote] : []), ...(result.warnings ?? [])];
			return c.json({
				ok: true,
				status: result.card.status,
				name: result.card.name,
				botId: result.card.botId ?? null,
				unchanged: result.unchanged === true,
				...(result.confirmation ? { confirmation: result.confirmation } : {}),
				...(warnings.length ? { warnings } : {}),
			});
		} catch (error) {
			console.error("resolve bot-proposal card failed", error instanceof Error ? error.message : "erro desconhecido");
			return c.json({ error: "Falha ao resolver a proposta." }, 503);
		}
	});

	return app;
}
