import { apiKeyService } from "@workspace/agent-runtime";
import { countPushSubscriptions, getMaintenanceStatus, getProviderConnection, hasComposioKey, listRecentFailures, pingDatabase } from "@workspace/db";
import { readRootVersion, readWorkerHeartbeat, sentryEnabled, type HeartbeatRedis } from "@workspace/observability";
import { API_KEY_PROVIDERS, API_KEY_PROVIDER_LABEL, buildInfo, maintenanceStatusView, shortReason, scrubString, type DiagnosticsCheck, type DiagnosticsQueue } from "@workspace/shared";
import type { DiagnosticsDeps } from "./diagnostics.js";

type CountingQueue = { name: string; getJobCounts: (...types: never[]) => Promise<Record<string, number>> };

/** Liga o Diagnóstico às dependências reais (banco, Redis, filas, cofre de chaves). */
export function createDefaultDiagnosticsDeps(input: { redis: (HeartbeatRedis & { ping: () => Promise<unknown> }) | null; queues: Array<CountingQueue | null> }): DiagnosticsDeps {
	const startedAt = new Date();
	const build = buildInfo("api", process.env, startedAt, readRootVersion());
	const queues = input.queues.filter((queue): queue is CountingQueue => Boolean(queue));
	return {
		env: process.env,
		now: () => new Date(),
		build,
		isOwner: async (email) => (await import("../auth.js")).isOwnerEmail(email),
		pingDb: pingDatabase,
		pingRedis: async (): Promise<DiagnosticsCheck> => {
			if (!input.redis) return { ok: false, ms: null, error: "não conectado" };
			const started = Date.now();
			try {
				await input.redis.ping();
				return { ok: true, ms: Date.now() - started };
			} catch (error) {
				return { ok: false, ms: null, error: shortReason(scrubString(error instanceof Error ? error.message : String(error))) };
			}
		},
		queues: async (): Promise<DiagnosticsQueue[] | null> => {
			if (queues.length === 0) return null;
			return Promise.all(
				queues.map(async (queue) => {
					const counts = await (queue.getJobCounts as (...types: string[]) => Promise<Record<string, number>>)("waiting", "active", "delayed", "failed");
					return { name: queue.name, waiting: counts.waiting ?? 0, active: counts.active ?? 0, delayed: counts.delayed ?? 0, failed: counts.failed ?? 0 };
				}),
			);
		},
		worker: async () => {
			if (!input.redis) return null;
			const beat = await readWorkerHeartbeat(input.redis);
			return beat ? { version: beat.version, commit: beat.commit, commitShort: beat.commitShort, startedAt: beat.startedAt, beatAt: beat.beatAt } : null;
		},
		pushSubscriptions: countPushSubscriptions,
		accountProviders: async (userId) => {
			const [keys, composio, chatgpt] = await Promise.all([
				Promise.all(API_KEY_PROVIDERS.map((provider) => apiKeyService.status(userId, provider))),
				hasComposioKey(userId),
				getProviderConnection(userId, "chatgpt"),
			]);
			return [
				...keys.map((key) => ({ id: key.provider, label: API_KEY_PROVIDER_LABEL[key.provider], present: key.status === "connected" })),
				{ id: "chatgpt", label: "ChatGPT (plano)", present: chatgpt?.status === "connected" },
				{ id: "composio", label: "Composio", present: composio },
			];
		},
		failures: listRecentFailures,
		maintenance: async (userId) => maintenanceStatusView(await getMaintenanceStatus(userId)),
		sentryEnabled,
	};
}
