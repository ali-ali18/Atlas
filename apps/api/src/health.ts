import { Hono } from "hono";

export type HealthDeps = {
	/** `SELECT 1` no Postgres. */
	checkDb: () => Promise<unknown>;
	/** `PING` no Redis (ausente = Redis não configurado). */
	checkRedis?: () => Promise<unknown>;
	/** Em shutdown a API se declara indisponível para sair da rotação antes de fechar. */
	isShuttingDown?: () => boolean;
	timeoutMs?: number;
};

type CheckState = "ok" | "fail";

async function runCheck(check: (() => Promise<unknown>) | undefined, timeoutMs: number): Promise<CheckState> {
	if (!check) return "fail";
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			check(),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
			}),
		]);
		return "ok";
	} catch {
		return "fail";
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * `/health` = liveness (o processo responde). `/health/ready` = prontidão: Postgres e
 * Redis respondem e a API não está encerrando. O healthcheck do compose usa o segundo.
 * A resposta traz só ok/fail por dependência, nunca mensagem de erro.
 */
export function createHealthRoutes(deps: HealthDeps) {
	const app = new Hono();
	const timeoutMs = deps.timeoutMs ?? 2_000;
	app.get("/health", (c) => c.json({ ok: true }));
	app.get("/health/ready", async (c) => {
		if (deps.isShuttingDown?.()) return c.json({ ok: false, shuttingDown: true }, 503);
		const [db, redis] = await Promise.all([runCheck(deps.checkDb, timeoutMs), runCheck(deps.checkRedis, timeoutMs)]);
		const ok = db === "ok" && redis === "ok";
		return c.json({ ok, checks: { db, redis } }, ok ? 200 : 503);
	});
	return app;
}
