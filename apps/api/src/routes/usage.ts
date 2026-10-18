import { Hono } from "hono";
import {
	DEFAULT_USAGE_PERIOD,
	USAGE_PERIODS,
	isUsagePeriod,
	isValidTimeZone,
	usagePeriodRange,
	type UsageResponse,
} from "@workspace/shared";
import { getUsage } from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

export type UsageRouteDeps = {
	getUsage?: typeof getUsage;
	clock?: () => Date;
};

/**
 * Uso do próprio usuário: `GET /v1/usage?period=today|7d|30d&tz=<IANA>`.
 * O dono vem só da sessão (`scopeFor`); `userId` na query é ignorado.
 * Só números agregados: sem ids de run, conteúdo nem segredo.
 */
export function createUsageRoutes(deps: UsageRouteDeps = {}) {
	const app = new Hono<AuthEnv>();
	const aggregate = deps.getUsage ?? getUsage;
	const clock = deps.clock ?? (() => new Date());

	app.get("/v1/usage", async (c) => {
		const periodParam = c.req.query("period");
		const tzParam = c.req.query("tz");
		const period = periodParam ?? DEFAULT_USAGE_PERIOD;
		if (!isUsagePeriod(period)) {
			return c.json({ error: `Período inválido: use ${USAGE_PERIODS.join(", ")}` }, 400);
		}
		const tz = tzParam ?? "UTC";
		if (!isValidTimeZone(tz)) {
			return c.json({ error: "Fuso horário inválido: use um nome IANA, como America/Sao_Paulo" }, 400);
		}
		try {
			const { userId } = scopeFor(c.get("session"));
			const { from, to } = usagePeriodRange(period, clock(), tz);
			const body: UsageResponse = {
				period,
				tz,
				from: from.toISOString(),
				to: to.toISOString(),
				...(await aggregate({ userId, from, to })),
			};
			return c.json(body);
		} catch (error) {
			console.error("get usage failed", error instanceof Error ? error.message : "unknown");
			return c.json({ error: "Falha ao carregar o uso" }, 503);
		}
	});

	return app;
}
