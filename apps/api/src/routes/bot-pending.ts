import { Hono } from "hono";
import { getOwnedConversation } from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import type { ApiConfig } from "../config.js";
import { answerBotPending, type PendingAnswer } from "../chat/bot-pending-answer.js";
import type { RunQueue } from "./run-queue.js";

function parseAnswers(raw: unknown): Record<string, string | string[]> | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const out: Record<string, string | string[]> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 30)) {
		if (typeof value === "string") out[key.slice(0, 80)] = value.slice(0, 2_000);
		else if (Array.isArray(value) && value.every((item) => typeof item === "string")) out[key.slice(0, 80)] = value.slice(0, 20).map((item: string) => item.slice(0, 2_000));
		else return null;
	}
	return Object.keys(out).length > 0 ? out : null;
}

/**
 * POST /v1/bot-pending/answer: responde, a partir da conversa do orquestrador, o card
 * que o bot de destino deixou esperando o usuário. Só a mesma conta; já resolvido
 * (inclusive pela conversa do destino) devolve `already` sem aplicar de novo.
 */
export function createBotPendingRoutes(config: Omit<ApiConfig, "agentRunQueue"> & { agentRunQueue: RunQueue | null }) {
	const app = new Hono<AuthEnv>();
	app.post("/v1/bot-pending/answer", async (c) => {
		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const body = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
		const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
		const cardId = typeof body.cardId === "string" ? body.cardId : "";
		if (!conversationId || !cardId) return c.json({ error: "Invalid body: expected { conversationId, cardId, decision }" }, 400);
		let answer: PendingAnswer;
		if (body.decision === "approve") answer = { type: "approve" };
		else if (body.decision === "reject") answer = { type: "reject", ...(typeof body.feedback === "string" && body.feedback.trim() ? { feedback: body.feedback.trim().slice(0, 1_000) } : {}) };
		else if (body.decision === "answer") {
			const answers = parseAnswers(body.answers);
			if (!answers) return c.json({ error: "Invalid answers" }, 400);
			answer = { type: "answer", answers };
		} else return c.json({ error: "Invalid decision" }, 400);

		const { userId } = scopeFor(c.get("session"));
		if (!(await getOwnedConversation(conversationId, userId))) return c.json({ error: "Conversation not found" }, 404);
		try {
			const result = await answerBotPending({ userId, conversationId, cardId, answer }, { queue: config.agentRunQueue, openRouterModel: config.openRouterModel });
			if (result.status === "invalid") return c.json({ error: result.error }, 404);
			if (result.status === "unavailable") return c.json({ error: result.error }, 503);
			return c.json(result, result.status === "applied" ? 202 : 200);
		} catch (error) {
			console.error("answer bot pending failed", error);
			return c.json({ error: "Failed to answer" }, 503);
		}
	});
	return app;
}
