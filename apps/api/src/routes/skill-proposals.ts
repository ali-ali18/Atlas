import { Hono } from "hono";
import {
	SkillDocError,
	applySkillProposal,
	getOwnedConversation,
	getPendingSkillProposal,
	resolveSkillProposalCard,
} from "@workspace/db";
import { SKILL_DOCUMENT_MAX_BYTES, parseSkillMarkdown } from "@workspace/shared";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

/**
 * Gate humano das propostas de skill do agente (PLANO-SKILLS K1). O conteúdo
 * aplicado é o que está GRAVADO no card da conversa do dono; o body só diz qual
 * proposta e a decisão. Conversa ou proposta de outro dono = 404.
 */
const NOT_FOUND = { error: "Proposta não encontrada ou já resolvida." } as const;
const STATUS_BY_KIND = { invalid: 400, conflict: 409, stale: 409, limit: 422, not_found: 404 } as const;

export function createSkillProposalRoutes() {
	const app = new Hono<AuthEnv>();

	/**
	 * POST /v1/cards/skill-proposal/resolve — `{ conversationId, proposalId, decision, markdown? }`.
	 * `markdown` (opcional, só em approved de create/edit) é o documento revisado pelo
	 * usuário no card ("editar antes"); passa pela mesma validação do parse.
	 */
	app.post("/v1/cards/skill-proposal/resolve", async (c) => {
		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
		const conversationId = typeof body?.conversationId === "string" ? body.conversationId.trim() : "";
		const proposalId = typeof body?.proposalId === "string" ? body.proposalId.trim() : "";
		const decision = body?.decision;
		if (!conversationId || !proposalId || (decision !== "approved" && decision !== "rejected")) {
			return c.json({ error: 'Corpo inválido: esperado { conversationId, proposalId, decision: "approved" | "rejected" }.' }, 400);
		}
		try {
			const { userId } = scopeFor(c.get("session"));
			if (!(await getOwnedConversation(conversationId, userId))) return c.json(NOT_FOUND, 404);
			const proposal = await getPendingSkillProposal(conversationId, proposalId);
			if (!proposal) return c.json(NOT_FOUND, 404);
			let applied = proposal;
			if (decision === "approved" && proposal.action !== "delete" && body?.markdown !== undefined) {
				const edited =
					typeof body.markdown === "string" && body.markdown.length <= SKILL_DOCUMENT_MAX_BYTES * 2
						? parseSkillMarkdown(body.markdown)
						: null;
				if (!edited) return c.json({ error: "Documento revisado inválido." }, 400);
				if (!edited.ok) return c.json({ error: edited.errors.join(" "), details: edited.errors }, 400);
				if (proposal.action === "edit" && edited.skill.name !== proposal.name) {
					return c.json({ error: "O nome da skill não pode mudar numa edição." }, 400);
				}
				applied = { ...proposal, ...edited.skill };
			}
			if (decision === "approved") await applySkillProposal(userId, applied);
			const card = await resolveSkillProposalCard(conversationId, proposalId, decision);
			if (!card) return c.json(NOT_FOUND, 404);
			return c.json({ ok: true, status: card.status, action: card.action, name: card.name });
		} catch (error) {
			if (error instanceof SkillDocError) {
				return c.json({ error: error.message, details: error.details }, STATUS_BY_KIND[error.kind]);
			}
			console.error("resolve skill-proposal card failed", error instanceof Error ? error.message : "erro desconhecido");
			return c.json({ error: "Falha ao resolver a proposta." }, 503);
		}
	});

	return app;
}
