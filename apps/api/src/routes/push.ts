import { Hono } from "hono";
import {
	getOwnedConversation,
	listPushSubscriptions,
	removePushSubscription,
	savePushSubscription,
	sendTestPush,
	type Presence,
	type PushSender,
} from "@workspace/db";
import { describeDevice, parsePushSubscription, type VapidConfig } from "@workspace/shared";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

export type PushRouteDeps = {
	/** null = chaves VAPID não configuradas (notificações desligadas no servidor). */
	vapid: VapidConfig | null;
	sender: PushSender | null;
	/** null = sem Redis: o sinal de "estou olhando" vira no-op (nunca bloqueia nem falha). */
	presence: Presence | null;
	now?: () => number;
};

const CLIENT_ID_MAX = 64;

export type PushDeviceResponse = { id: string; label: string; createdAt: string; lastUsedAt: string; failing: boolean };

/**
 * Notificações push do usuário: configuração pública (chave VAPID), inscrições por aparelho,
 * teste e o sinal de "estou olhando esta conversa" (suprime a notificação enquanto alguém olha).
 */
export function createPushRoutes(deps: PushRouteDeps) {
	const app = new Hono<AuthEnv>();
	const clock = deps.now ?? (() => Date.now());

	app.get("/v1/push/config", (c) => c.json({ enabled: Boolean(deps.vapid && deps.sender), publicKey: deps.vapid?.publicKey ?? null }));

	app.get("/v1/push/subscriptions", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		try {
			const rows = await listPushSubscriptions(userId);
			const devices: PushDeviceResponse[] = rows.map((row) => ({
				id: row.id,
				label: describeDevice(row.userAgent),
				createdAt: row.createdAt.toISOString(),
				lastUsedAt: row.lastUsedAt.toISOString(),
				failing: row.failureCount > 0,
			}));
			// `endpoints` deixa o navegador saber qual destes é ele (sem expor chaves).
			return c.json({ devices, endpoints: rows.map((row) => ({ id: row.id, endpoint: row.endpoint })) });
		} catch (error) {
			console.error("list push subscriptions failed", error);
			return c.json({ error: "Failed to list devices" }, 503);
		}
	});

	app.post("/v1/push/subscriptions", async (c) => {
		if (!deps.vapid) return c.json({ error: "Push notifications are not configured" }, 503);
		const { userId } = scopeFor(c.get("session"));
		const body: unknown = await c.req.json().catch(() => null);
		const parsed = parsePushSubscription(body, c.req.header("user-agent"));
		if (!parsed) return c.json({ error: "Invalid subscription" }, 400);
		try {
			const row = await savePushSubscription(userId, parsed);
			return c.json({ id: row.id, label: describeDevice(row.userAgent) }, 201);
		} catch (error) {
			console.error("save push subscription failed", error);
			return c.json({ error: "Failed to save subscription" }, 503);
		}
	});

	app.delete("/v1/push/subscriptions/:id", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		try {
			const removed = await removePushSubscription(userId, { id: c.req.param("id") });
			return removed ? c.json({ removed }) : c.json({ error: "Device not found" }, 404);
		} catch (error) {
			console.error("remove push subscription failed", error);
			return c.json({ error: "Failed to remove device" }, 503);
		}
	});

	/** Desinscrição pelo endpoint (o navegador conhece o seu, não o id). */
	app.post("/v1/push/unsubscribe", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const body = (await c.req.json().catch(() => null)) as { endpoint?: unknown } | null;
		const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
		if (!endpoint) return c.json({ error: "Invalid endpoint" }, 400);
		try {
			return c.json({ removed: await removePushSubscription(userId, { endpoint }) });
		} catch (error) {
			console.error("unsubscribe push failed", error);
			return c.json({ error: "Failed to unsubscribe" }, 503);
		}
	});

	app.post("/v1/push/test", async (c) => {
		if (!deps.sender) return c.json({ error: "Push notifications are not configured" }, 503);
		const { userId } = scopeFor(c.get("session"));
		try {
			const result = await sendTestPush(userId, deps.sender, clock());
			if (result.devices === 0) return c.json({ error: "No devices registered" }, 409);
			return c.json(result);
		} catch (error) {
			console.error("push test failed", error);
			return c.json({ error: "Failed to send test" }, 503);
		}
	});

	/** Sinal de vida de um cliente visível (a cada 20s, validade 45s) ou fim dele (`viewing:false`). */
	app.post("/v1/conversations/:id/viewing", async (c) => {
		const id = c.req.param("id");
		const { userId } = scopeFor(c.get("session"));
		const body = (await c.req.json().catch(() => null)) as { clientId?: unknown; viewing?: unknown } | null;
		const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
		if (!clientId || clientId.length > CLIENT_ID_MAX || typeof body?.viewing !== "boolean") return c.json({ error: "Invalid body" }, 400);
		if (!id.trim() || !(await getOwnedConversation(id, userId))) return c.json({ error: "Conversation not found" }, 404);
		try {
			if (deps.presence) {
				if (body.viewing) await deps.presence.touch(userId, id, clientId, clock());
				else await deps.presence.clear(userId, id, clientId);
			}
			return c.json({ ok: true });
		} catch (error) {
			// Redis fora do ar não pode quebrar o app; sem o sinal só se notifica a mais.
			console.error("viewing signal failed", error);
			return c.json({ ok: false });
		}
	});

	return app;
}
