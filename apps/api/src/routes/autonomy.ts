import { Hono } from "hono";
import {
	DEFAULT_AUTONOMY_LEVEL,
	applyAutonomyUpdate,
	parseAutonomyPolicy,
	parseAutonomyUpdate,
	resolveAutonomy,
	type AutonomyView,
} from "@workspace/shared";
import {
	loadAutonomyContext,
	setAccountAutonomy,
	setBotAutonomy,
} from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

const INVALID_BODY =
	"Invalid body: expected { level?: 'autonomous'|'balanced'|'always_ask'|null, duration?: '1d'|'7d'|'30d'|'forever', exceptions?: [{ connector?|tool?, mode }] }";

/** Visão de um escopo: o guardado + o que vale de fato. */
function toView(scope: "bot" | "account", ctx: Awaited<ReturnType<typeof loadAutonomyContext>>, now: Date): AutonomyView {
	const resolved = resolveAutonomy({ bot: ctx.botRaw, account: ctx.accountRaw, now });
	const raw = scope === "bot" ? ctx.botRaw : ctx.accountRaw;
	return { stored: parseAutonomyPolicy(raw), effective: resolved.policy, source: resolved.source };
}

/**
 * Autonomia do agente (F10): padrão da conta e override por bot. O escopo vem
 * da sessão; bot de outro dono responde 404.
 */
export function createAutonomyRoutes(clock: () => Date = () => new Date()) {
	const app = new Hono<AuthEnv>();

	app.get("/v1/autonomy", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const ctx = await loadAutonomyContext({ userId });
			return c.json(toView("account", ctx, clock()));
		} catch (error) {
			console.error("get autonomy failed", error);
			return c.json({ error: "Failed to get autonomy" }, 503);
		}
	});

	app.put("/v1/autonomy", async (c) => {
		const update = parseAutonomyUpdate(await c.req.json().catch(() => null));
		if (!update) return c.json({ error: INVALID_BODY }, 400);
		try {
			const { userId } = scopeFor(c.get("session"));
			const now = clock();
			const ctx = await loadAutonomyContext({ userId });
			const current = parseAutonomyPolicy(ctx.accountRaw);
			const next = applyAutonomyUpdate({
				current,
				update,
				scope: "account",
				levelBeforeChange: current?.level ?? DEFAULT_AUTONOMY_LEVEL,
				now,
			});
			await setAccountAutonomy(userId, next);
			return c.json(toView("account", await loadAutonomyContext({ userId }), now));
		} catch (error) {
			console.error("update autonomy failed", error);
			return c.json({ error: "Failed to update autonomy" }, 503);
		}
	});

	app.get("/v1/bots/:id/autonomy", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const ctx = await loadAutonomyContext({ userId, botId: c.req.param("id") });
			if (ctx.botName === null) return c.json({ error: "Bot not found" }, 404);
			return c.json(toView("bot", ctx, clock()));
		} catch (error) {
			console.error("get bot autonomy failed", error);
			return c.json({ error: "Failed to get autonomy" }, 503);
		}
	});

	app.put("/v1/bots/:id/autonomy", async (c) => {
		const update = parseAutonomyUpdate(await c.req.json().catch(() => null));
		if (!update) return c.json({ error: INVALID_BODY }, 400);
		try {
			const { userId } = scopeFor(c.get("session"));
			const botId = c.req.param("id");
			const now = clock();
			const ctx = await loadAutonomyContext({ userId, botId });
			if (ctx.botName === null) return c.json({ error: "Bot not found" }, 404);
			const current = parseAutonomyPolicy(ctx.botRaw);
			const accountLevel = parseAutonomyPolicy(ctx.accountRaw)?.level ?? DEFAULT_AUTONOMY_LEVEL;
			const next = applyAutonomyUpdate({
				current,
				update,
				scope: "bot",
				levelBeforeChange: current?.level ?? accountLevel,
				now,
			});
			if (!(await setBotAutonomy(botId, userId, next))) return c.json({ error: "Bot not found" }, 404);
			return c.json(toView("bot", await loadAutonomyContext({ userId, botId }), now));
		} catch (error) {
			console.error("update bot autonomy failed", error);
			return c.json({ error: "Failed to update autonomy" }, 503);
		}
	});

	return app;
}
