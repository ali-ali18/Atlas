import { Hono } from "hono";
import type {
	AppendMessageInput,
	CreateConversationResponse,
	SessionMessage,
} from "@workspace/shared";
import {
	appendConversationMessage,
	appendConversationCard,
	createConversation,
	getOwnedConversation,
	listConversationMessages,
	markConversationResultsSeen,
	markConversationRead,
	markConversationUnread,
	getUnreadState,
	resolveBotProfileCard,
	updateBot,
	parseImageAttachments,
	resolveUserImagesCard,
} from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import { compactConversation, COMPACT_MESSAGES } from "../chat/compact-conversation.js";

function parseAppendMessage(body: unknown): (AppendMessageInput & { attachments: Array<{ artifactId: string }> }) | null {
	if (typeof body !== "object" || body === null) {
		return null;
	}
	if (!("role" in body) || !("content" in body)) {
		return null;
	}
	const { role, content } = body as { role: unknown; content: unknown };
	const attachments = parseImageAttachments((body as { attachments?: unknown }).attachments);
	if (!attachments) return null;
	if (typeof role !== "string" || typeof content !== "string") {
		return null;
	}
	if (content.trim().length === 0 && attachments.length === 0) {
		return null;
	}
	const roles = ["system", "user", "assistant", "tool"] as const;
	if (!roles.includes(role as (typeof roles)[number])) {
		return null;
	}
	if (attachments.length && role !== "user") return null;
	return { role: role as AppendMessageInput["role"], content, attachments };
}

export function createConversationRoutes(options: { compact?: typeof compactConversation } = {}) {
	const app = new Hono<AuthEnv>();

	app.post("/v1/conversations", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const { id } = await createConversation(userId);
			const body: CreateConversationResponse = { id };
			return c.json(body, 201);
		} catch (error) {
			console.error("create conversation failed", error);
			return c.json({ error: "Failed to create conversation" }, 503);
		}
	});

	app.get("/v1/conversations/:id/messages", async (c) => {
		const id = c.req.param("id");
		if (!id.trim()) {
			return c.json({ error: "Missing conversation id" }, 400);
		}
		const { userId } = scopeFor(c.get("session"));
		if (!(await getOwnedConversation(id, userId))) {
			return c.json({ error: "Conversation not found" }, 404);
		}
		const limitRaw = c.req.query("limit");
		const limit = limitRaw === undefined ? 100 : Number(limitRaw);
		if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
			return c.json({ error: "Invalid limit: expected 1..200" }, 400);
		}
		const beforeCreatedAt = c.req.query("beforeCreatedAt");
		const beforeId = c.req.query("beforeId");
		if (
			(beforeCreatedAt === undefined) !== (beforeId === undefined) ||
			(beforeCreatedAt !== undefined &&
				(!beforeId?.trim() || Number.isNaN(Date.parse(beforeCreatedAt))))
		) {
			return c.json({ error: "Invalid history cursor" }, 400);
		}

		try {
			const rows: SessionMessage[] = await listConversationMessages(
				id,
				limit + 1,
				beforeCreatedAt !== undefined && beforeId !== undefined
					? { createdAt: beforeCreatedAt, id: beforeId }
					: undefined,
			);
			return c.json({ messages: rows.slice(-limit), hasMore: rows.length > limit });
		} catch (error) {
			console.error("list messages failed", error);
			return c.json({ error: "Failed to list messages" }, 503);
		}
	});

	/** O usuário abriu a conversa: resultados de runs em background contam como vistos (some o badge e o e-mail). */
	app.post("/v1/conversations/:id/results/seen", async (c) => {
		const id = c.req.param("id");
		const { userId } = scopeFor(c.get("session"));
		if (!id.trim() || !(await getOwnedConversation(id, userId))) {
			return c.json({ error: "Conversation not found" }, 404);
		}
		try {
			const seen = await markConversationResultsSeen({ userId, conversationId: id });
			return c.json({ seen });
		} catch (error) {
			console.error("mark results seen failed", error);
			return c.json({ error: "Failed to mark results as seen" }, 503);
		}
	});

	/**
	 * `/compact`: resume a conversa levada para os próximos turnos e deixa o cartão na thread. Só o dono; recusa com
	 * 409 enquanto houver aprovação pendente ou execução em andamento. Body: { focus?: string }.
	 */
	app.post("/v1/conversations/:id/compact", async (c) => {
		const id = c.req.param("id");
		const { userId } = scopeFor(c.get("session"));
		if (!id.trim() || !(await getOwnedConversation(id, userId))) {
			return c.json({ error: "Conversation not found" }, 404);
		}
		const body: unknown = await c.req.json().catch(() => ({}));
		const focus = typeof body === "object" && body !== null && typeof (body as { focus?: unknown }).focus === "string" ? (body as { focus: string }).focus : undefined;
		try {
			const outcome = await (options.compact ?? compactConversation)({ userId, conversationId: id, ...(focus ? { focus } : {}) });
			if (outcome.kind === "compacted") {
				const { kind: _kind, ...rest } = outcome;
				return c.json({ status: "compacted" as const, ...rest });
			}
			if (outcome.kind === "noop") return c.json({ status: "noop" as const, reason: outcome.reason, message: outcome.message });
			if (outcome.kind === "blocked") return c.json({ error: outcome.message, reason: outcome.reason }, 409);
			return c.json({ error: outcome.message }, 502);
		} catch (error) {
			console.error("compact conversation failed", error);
			return c.json({ error: COMPACT_MESSAGES.failed }, 503);
		}
	});

	/** Estado de leitura da conversa (contagem, primeira não lida, marca manual). */
	app.get("/v1/conversations/:id/read", async (c) => {
		const id = c.req.param("id");
		const { userId } = scopeFor(c.get("session"));
		if (!id.trim() || !(await getOwnedConversation(id, userId))) {
			return c.json({ error: "Conversation not found" }, 404);
		}
		try {
			return c.json(await getUnreadState(userId, id));
		} catch (error) {
			console.error("get read state failed", error);
			return c.json({ error: "Failed to read state" }, 503);
		}
	});

	/** Marca como lida até uma mensagem ou instante; nunca anda para trás. Body: { upToMessageId } | { upToAt } | {}. */
	app.post("/v1/conversations/:id/read", async (c) => {
		const id = c.req.param("id");
		const { userId } = scopeFor(c.get("session"));
		if (!id.trim() || !(await getOwnedConversation(id, userId))) {
			return c.json({ error: "Conversation not found" }, 404);
		}
		let body: { upToMessageId?: unknown; upToAt?: unknown } = {};
		try {
			const json: unknown = await c.req.json();
			if (typeof json === "object" && json !== null) body = json;
		} catch {
			// corpo vazio = "até agora"
		}
		const upToMessageId = typeof body.upToMessageId === "string" && body.upToMessageId.trim() ? body.upToMessageId.trim() : null;
		let upToAt: Date | null = null;
		if (body.upToAt !== undefined) {
			upToAt = typeof body.upToAt === "string" ? new Date(body.upToAt) : null;
			if (!upToAt || Number.isNaN(upToAt.getTime())) return c.json({ error: "Invalid upToAt" }, 400);
		}
		try {
			const state = await markConversationRead({ userId, conversationId: id, upToMessageId, upToAt });
			if (!state) return c.json({ error: "Message not found" }, 404);
			return c.json(state);
		} catch (error) {
			console.error("mark read failed", error);
			return c.json({ error: "Failed to mark as read" }, 503);
		}
	});

	/** "Marcar como não lido": vale em todos os dispositivos até a próxima leitura. */
	app.post("/v1/conversations/:id/unread", async (c) => {
		const id = c.req.param("id");
		const { userId } = scopeFor(c.get("session"));
		if (!id.trim() || !(await getOwnedConversation(id, userId))) {
			return c.json({ error: "Conversation not found" }, 404);
		}
		try {
			return c.json(await markConversationUnread({ userId, conversationId: id }));
		} catch (error) {
			console.error("mark unread failed", error);
			return c.json({ error: "Failed to mark as unread" }, 503);
		}
	});

	app.post("/v1/conversations/:id/messages", async (c) => {
		const id = c.req.param("id");
		if (!id.trim()) {
			return c.json({ error: "Missing conversation id" }, 400);
		}
		const { userId } = scopeFor(c.get("session"));
		if (!(await getOwnedConversation(id, userId))) {
			return c.json({ error: "Conversation not found" }, 404);
		}

		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const input = parseAppendMessage(json);
		if (!input) {
			return c.json(
				{
					error:
						"Invalid body: expected { role, content } with non-empty content",
				},
				400,
			);
		}
		let imagesCard;
		try { imagesCard = await resolveUserImagesCard(input.attachments, userId); }
		catch { return c.json({ error: "anexo inválido" }, 400); }

		try {
			const message = await appendConversationMessage(
				id,
				input.role,
				input.content,
			);
			if (imagesCard) await appendConversationCard(id, imagesCard);
			return c.json({ message }, 201);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === "Conversation not found"
			) {
				return c.json({ error: "Conversation not found" }, 404);
			}
			console.error("append message failed", error);
			return c.json({ error: "Failed to append message" }, 503);
		}
	});

	/**
	 * POST /v1/cards/bot-profile/resolve — gate humano da proposta de perfil.
	 * Body: `{ conversationId, proposalId, decision: "approved" | "rejected" }`.
	 * - approved: aplica o `after` no bot (`PATCH` interno) + marca approved.
	 * - rejected: só marca rejected (nada muda no bot).
	 * 404 se não há proposta pendente com esse ID.
	 */
	app.post("/v1/cards/bot-profile/resolve", async (c) => {
		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		if (typeof json !== "object" || json === null) {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const body = json as Record<string, unknown>;
		const conversationId =
			typeof body.conversationId === "string" ? body.conversationId.trim() : "";
		const proposalId =
			typeof body.proposalId === "string" ? body.proposalId.trim() : "";
		const decision = body.decision;
		if (!conversationId || !proposalId) {
			return c.json(
				{ error: "Invalid body: expected { conversationId, proposalId, decision }" },
				400,
			);
		}
		if (decision !== "approved" && decision !== "rejected") {
			return c.json(
				{ error: 'Invalid decision: expected "approved" | "rejected"' },
				400,
			);
		}

		try {
			const { userId } = scopeFor(c.get("session"));
			if (!(await getOwnedConversation(conversationId, userId))) {
				return c.json({ error: "Proposal not found or already resolved" }, 404);
			}
			const card = await resolveBotProfileCard(
				conversationId,
				proposalId,
				decision,
			);
			if (!card) {
				return c.json(
					{ error: "Proposal not found or already resolved" },
					404,
				);
			}
			if (decision === "approved") {
				await updateBot(card.botId, { ...card.after }, userId);
			}
			return c.json({ ok: true, status: card.status, fields: card.fields });
		} catch (error) {
			console.error("resolve bot-profile card failed", error);
			return c.json({ error: "Failed to resolve proposal" }, 503);
		}
	});

	return app;
}
