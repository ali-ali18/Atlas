import { Hono } from "hono";
import { enqueueManualReflection, getAccountConfig, getMemorySnapshot, getPrimaryBot, listReflections, type EnqueueManualResult, type ReflectionView } from "@workspace/db";
import { readReflectionSettings, reflectionTimeZone, resolveOrchestratorMemoryChars, type ReflectionSettings } from "@workspace/shared";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

/**
 * Reflexão diária do orquestrador: estado para a tela de configurações, "Refletir agora" e o
 * histórico (o que foi alterado, com o texto anterior). Ligar/desligar e o horário vão pelo
 * PATCH /v1/settings (`reflection.enabled` / `reflection.time`). Tudo escopado pelo usuário.
 */
export type ReflectionRouteDeps = {
	loadConfig: (userId: string) => Promise<{ reflection?: { enabled?: unknown; time?: unknown; memoryChars?: unknown }; general?: { timezone?: string } }>;
	hasPrimary: (userId: string) => Promise<boolean>;
	list: (userId: string, limit: number) => Promise<ReflectionView[]>;
	enqueue: (userId: string) => Promise<EnqueueManualResult>;
	/** Uso da memória do bot principal (caracteres usados e limite em vigor). */
	memoryUsage: (userId: string) => Promise<{ used: number; limit: number } | null>;
};

const defaults: ReflectionRouteDeps = {
	loadConfig: (userId) => getAccountConfig(userId),
	hasPrimary: async (userId) => Boolean(await getPrimaryBot(userId)),
	list: listReflections,
	enqueue: (userId) => enqueueManualReflection(userId),
	memoryUsage: async (userId) => {
		const primary = await getPrimaryBot(userId);
		return primary ? (await getMemorySnapshot(userId, primary.id)).memory.usage : null;
	},
};

function viewForList(item: ReflectionView) {
	const { changes, stats, ...rest } = item;
	return { ...rest, changeCount: changes.length, stats };
}

export function createReflectionRoutes(deps: ReflectionRouteDeps = defaults) {
	const app = new Hono<AuthEnv>();

	app.get("/v1/reflection", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const [config, hasPrimary, recent, usage] = await Promise.all([deps.loadConfig(userId), deps.hasPrimary(userId), deps.list(userId, 5), deps.memoryUsage(userId).catch(() => null)]);
			const settings: ReflectionSettings = readReflectionSettings(config);
			const last = recent.find((item) => item.status === "done" || item.status === "skipped" || item.status === "failed") ?? null;
			const active = recent.some((item) => item.status === "queued" || item.status === "running");
			const memory = { limit: usage?.limit ?? resolveOrchestratorMemoryChars(config), used: usage?.used ?? null };
			return c.json({ settings, memory, timezone: reflectionTimeZone(config.general?.timezone), hasPrimary, active, last: last ? viewForList(last) : null });
		} catch (error) {
			console.error("get reflection failed", error);
			return c.json({ error: "Não foi possível carregar a reflexão." }, 503);
		}
	});

	app.post("/v1/reflection/run", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const result = await deps.enqueue(userId);
			if (!result.ok) {
				return result.reason === "no-primary"
					? c.json({ error: "Defina um bot principal para refletir." }, 400)
					: c.json({ error: "Já há uma reflexão em andamento." }, 409);
			}
			return c.json({ ok: true, id: result.id }, 202);
		} catch (error) {
			console.error("enqueue reflection failed", error);
			return c.json({ error: "Não foi possível iniciar a reflexão." }, 503);
		}
	});

	app.get("/v1/reflection/history", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const limit = Math.max(1, Math.min(50, Number(c.req.query("limit")) || 10));
			return c.json({ items: await deps.list(userId, limit) });
		} catch (error) {
			console.error("list reflections failed", error);
			return c.json({ error: "Não foi possível carregar o histórico." }, 503);
		}
	});

	return app;
}
