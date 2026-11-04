import { Hono } from "hono";
import { cancelConversationReturn, getOwnedConversation, listPendingReturns, type ConversationReturnRecord } from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import { cancelScheduledReturnJob } from "../chat/owner-wait.js";

/**
 * "Volto depois" do motor v3 (PR8a): o marcador "Volto às HH:MM" lista e cancela os retornos pendentes da conversa.
 * Escopo pela sessão: conversa ou retorno de outro dono = 404. Portas injetáveis nos testes.
 */
export type ReturnRouteDeps = {
	conversationOwned(conversationId: string, userId: string): Promise<boolean>;
	list(userId: string, conversationId: string): Promise<ConversationReturnRecord[]>;
	cancel(userId: string, returnId: string, conversationId: string): Promise<ConversationReturnRecord | null>;
	cancelJob(returnId: string): Promise<void>;
};

const defaultDeps: ReturnRouteDeps = {
	conversationOwned: async (conversationId, userId) => Boolean(await getOwnedConversation(conversationId, userId)),
	list: listPendingReturns,
	cancel: cancelConversationReturn,
	cancelJob: cancelScheduledReturnJob,
};

const view = (item: ConversationReturnRecord) => ({ id: item.id, at: item.dueAt.toISOString(), reason: item.reason, visible: item.visible, status: item.status });

export function createReturnRoutes(deps: ReturnRouteDeps = defaultDeps) {
	const app = new Hono<AuthEnv>();

	app.get("/v1/conversations/:id/returns", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const conversationId = c.req.param("id");
		if (!(await deps.conversationOwned(conversationId, userId))) return c.json({ error: "Conversation not found" }, 404);
		// O silencioso (follow-up que o bot decidiu) não aparece para o dono: só o prometido a ele.
		return c.json({ returns: (await deps.list(userId, conversationId)).filter((item) => item.visible).map(view) });
	});

	app.post("/v1/conversations/:id/returns/:returnId/cancel", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const conversationId = c.req.param("id");
		if (!(await deps.conversationOwned(conversationId, userId))) return c.json({ error: "Conversation not found" }, 404);
		const cancelled = await deps.cancel(userId, c.req.param("returnId"), conversationId);
		if (!cancelled) return c.json({ error: "Return not found" }, 404);
		await deps.cancelJob(cancelled.id);
		return c.json({ return: view(cancelled) });
	});

	return app;
}
