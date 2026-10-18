import { Hono } from "hono";
import { cancelFollowup, listFollowups, rescheduleOwnedFollowup, resolveRoutineProposal } from "@workspace/db";
import { removeRoutineScheduler, syncRoutineScheduler, type RoutineQueue } from "@workspace/queue";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

/**
 * Modo proativo: clique nos cards de rotina que o bot propôs e lembretes agendados.
 * Tudo escopado pelo usuário da sessão; id de outro dono responde 404.
 */
type FollowupView = { id: string; note: string; kind: string; dueAt: Date; source: string; stages: Array<{ at: string; firedAt?: string | null }> };

function followupView(item: FollowupView) {
	return { id: item.id, note: item.note, kind: item.kind, dueAt: item.dueAt.toISOString(), source: item.source, stages: item.stages };
}

export function createProactiveRoutes(routineQueue: RoutineQueue | null, now: () => Date = () => new Date()) {
	const app = new Hono<AuthEnv>();

	/**
	 * POST /v1/cards/routine-proposal/resolve — `{ messageId, decision: "accept" | "decline" }`.
	 * Sugerir: accept cria a rotina, decline dispensa. Automático: accept mantém, decline desfaz.
	 */
	app.post("/v1/cards/routine-proposal/resolve", async (c) => {
		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
		const messageId = typeof body?.messageId === "string" ? body.messageId.trim() : "";
		const decision = body?.decision;
		if (!messageId || (decision !== "accept" && decision !== "decline")) {
			return c.json({ error: 'Corpo inválido: esperado { messageId, decision: "accept" | "decline" }.' }, 400);
		}
		try {
			const { userId } = scopeFor(c.get("session"));
			const result = await resolveRoutineProposal({ userId, messageId, decision });
			if (!result.ok) return c.json({ error: result.error }, result.status);
			if (routineQueue) {
				if (result.created) await syncRoutineScheduler(routineQueue, result.created).catch(() => undefined);
				if (result.deletedRoutineId) await removeRoutineScheduler(routineQueue, result.deletedRoutineId).catch(() => undefined);
			}
			return c.json({
				ok: true,
				status: result.card.status,
				mode: result.card.mode,
				...(result.card.routineId ? { routineId: result.card.routineId } : {}),
				...(result.unchanged ? { unchanged: true } : {}),
			});
		} catch (error) {
			console.error("resolve routine proposal failed", error);
			return c.json({ error: "Não consegui resolver a proposta." }, 503);
		}
	});

	app.get("/v1/bots/:botId/followups", async (c) => {
		const botId = c.req.param("botId").trim();
		if (!botId) return c.json({ error: "Missing bot id" }, 400);
		try {
			const { userId } = scopeFor(c.get("session"));
			const items = await listFollowups(userId, botId, { limit: 50 });
			return c.json({
				followups: items.map(followupView),
			});
		} catch (error) {
			console.error("list followups failed", error);
			return c.json({ error: "Failed to list followups" }, 503);
		}
	});

	/**
	 * PATCH /v1/bots/:botId/followups/:followupId — `{ when, stage? }` (`stage`: aviso a mover, 1 = primeiro; padrão o próximo pendente; ISO sem fuso = fuso da conta, ou texto
	 * como "amanhã 9h"). Passado é 400; dentro do silêncio vai para o fim dele (`movedForQuietHours`).
	 */
	app.patch("/v1/bots/:botId/followups/:followupId", async (c) => {
		const botId = c.req.param("botId").trim();
		const followupId = c.req.param("followupId").trim();
		if (!botId || !followupId) return c.json({ error: "Missing bot id or followup id" }, 400);
		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
		const when = typeof body?.when === "string" ? body.when.trim() : "";
		if (!when) return c.json({ error: "Corpo inválido: esperado { when, stage? }." }, 400);
		const stage = body?.stage;
		if (stage !== undefined && (typeof stage !== "number" || !Number.isInteger(stage) || stage < 1 || stage > 4)) {
			return c.json({ error: "stage deve ser um inteiro de 1 a 4." }, 400);
		}
		try {
			const { userId } = scopeFor(c.get("session"));
			const result = await rescheduleOwnedFollowup({ userId, botId, followupId, when, ...(stage !== undefined ? { stage } : {}), now: now() });
			if (!result.ok) return c.json({ error: result.error }, result.status);
			return c.json({
				ok: true,
				followup: followupView(result.followup),
				movedForQuietHours: result.movedForQuietHours,
				requestedFor: result.requestedFor.toISOString(),
			});
		} catch (error) {
			console.error("reschedule followup failed", error);
			return c.json({ error: "Failed to reschedule followup" }, 503);
		}
	});

	app.delete("/v1/bots/:botId/followups/:followupId", async (c) => {
		const botId = c.req.param("botId").trim();
		const followupId = c.req.param("followupId").trim();
		if (!botId || !followupId) return c.json({ error: "Missing bot id or followup id" }, 400);
		try {
			const { userId } = scopeFor(c.get("session"));
			const ok = await cancelFollowup(userId, followupId, botId);
			if (!ok) return c.json({ error: "Lembrete não encontrado ou já concluído." }, 404);
			return c.json({ ok: true });
		} catch (error) {
			console.error("cancel followup failed", error);
			return c.json({ error: "Failed to cancel followup" }, 503);
		}
	});

	return app;
}
