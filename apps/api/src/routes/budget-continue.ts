import { Hono } from "hono";
import { resolveBudgetContinue } from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import { enqueueAgentRunJob } from "./runs.js";
import type { RunQueue } from "./run-queue.js";

/**
 * "Continuar pesquisa (+US$ X)": a aprovação é o único jeito de gastar mais depois de um trabalho longo parar por
 * orçamento. O valor e o run de origem são os GRAVADOS no card da conversa do dono; o corpo só diz qual card e a
 * decisão. Conversa, card ou run de outro dono = 404. Aprovar duas vezes devolve o mesmo resultado, sem outro run.
 */
export type BudgetContinueRouteDeps = {
	resolve?: typeof resolveBudgetContinue;
	/** Fila de runs do worker (ausente = o run fica `queued` e a reconciliação o enfileira). */
	queue?: RunQueue | null;
	enqueue?: (queue: RunQueue, runId: string) => Promise<boolean>;
};

export function createBudgetContinueRoutes(deps: BudgetContinueRouteDeps = {}) {
	const resolve = deps.resolve ?? resolveBudgetContinue;
	const enqueue = deps.enqueue ?? enqueueAgentRunJob;
	const app = new Hono<AuthEnv>();

	/** POST /v1/cards/budget-continue/resolve: `{ conversationId, offerId, decision: "approved" | "dismissed" }`. */
	app.post("/v1/cards/budget-continue/resolve", async (c) => {
		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
		const conversationId = typeof body?.conversationId === "string" ? body.conversationId.trim() : "";
		const offerId = typeof body?.offerId === "string" ? body.offerId.trim() : "";
		const decision = body?.decision;
		if (!conversationId || !offerId || (decision !== "approved" && decision !== "dismissed")) {
			return c.json({ error: 'Corpo inválido: esperado { conversationId, offerId, decision: "approved" | "dismissed" }.' }, 400);
		}
		try {
			const { userId } = scopeFor(c.get("session"));
			const result = await resolve({ userId, conversationId, offerId, decision });
			if (!result.ok) return c.json({ error: result.error }, result.status);
			// Run criado agora: enfileira. Se a fila falhar o run fica `queued` e a reconciliação o pega.
			const enqueued = result.runId ? (deps.queue ? await enqueue(deps.queue, result.runId) : false) : undefined;
			return c.json({
				ok: true,
				status: result.card.status,
				unchanged: result.unchanged === true,
				runId: result.card.continuationRunId ?? null,
				...(enqueued !== undefined ? { enqueued } : {}),
			});
		} catch (error) {
			console.error("resolve budget-continue card failed", error instanceof Error ? error.message : "erro desconhecido");
			return c.json({ error: "Falha ao resolver o pedido." }, 503);
		}
	});

	return app;
}
