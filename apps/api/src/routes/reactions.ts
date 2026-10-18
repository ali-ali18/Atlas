import { Hono } from "hono";
import { getOwnedMessageReactions, setUserReaction } from "@workspace/db";
import { normalizeReactionEmoji } from "@workspace/shared";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

type Deps = { setUserReaction: typeof setUserReaction; getOwnedMessageReactions: typeof getOwnedMessageReactions };

/**
 * Reação do usuário a uma fala (uma por mensagem). O dono vem da sessão; mensagem de outra conta, cartão ou
 * inexistente = 404 (sem revelar qual). As outras abas/aparelhos são avisados pelo hub (gatilho do banco).
 *
 * - `GET    /v1/messages/:messageId/reactions` reações atuais
 * - `PUT    /v1/messages/:messageId/reaction`  body `{ emoji }` (troca a anterior)
 * - `DELETE /v1/messages/:messageId/reaction`  tira a do usuário
 */
export function createReactionRoutes(deps: Deps = { setUserReaction, getOwnedMessageReactions }) {
	const app = new Hono<AuthEnv>();

	app.get("/v1/messages/:messageId/reactions", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		try {
			const result = await deps.getOwnedMessageReactions(userId, c.req.param("messageId"));
			if (!result) return c.json({ error: "Message not found" }, 404);
			return c.json({ reactions: result.reactions });
		} catch (error) {
			console.error("get reactions failed", error);
			return c.json({ error: "Failed to read reactions" }, 503);
		}
	});

	app.put("/v1/messages/:messageId/reaction", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const emoji = normalizeReactionEmoji((body as { emoji?: unknown } | null)?.emoji);
		if (!emoji) return c.json({ error: "Invalid emoji" }, 400);
		try {
			const result = await deps.setUserReaction({ userId, messageId: c.req.param("messageId"), emoji });
			if (!result) return c.json({ error: "Message not found" }, 404);
			return c.json({ reactions: result.reactions });
		} catch (error) {
			console.error("set reaction failed", error);
			return c.json({ error: "Failed to save reaction" }, 503);
		}
	});

	app.delete("/v1/messages/:messageId/reaction", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		try {
			const result = await deps.setUserReaction({ userId, messageId: c.req.param("messageId"), emoji: null });
			if (!result) return c.json({ error: "Message not found" }, 404);
			return c.json({ reactions: result.reactions });
		} catch (error) {
			console.error("clear reaction failed", error);
			return c.json({ error: "Failed to clear reaction" }, 503);
		}
	});

	return app;
}
