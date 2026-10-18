import { readRootVersion } from "./version.js";
import { buildInfo, type BuildInfo, type EnvLike } from "@workspace/shared";

/** Subconjunto do ioredis usado aqui (facilita testar). */
export type HeartbeatRedis = {
	set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
	get(key: string): Promise<string | null>;
};

export const WORKER_HEARTBEAT_KEY = "atlas:worker:heartbeat";
export const WORKER_HEARTBEAT_TTL_S = 45;
const BEAT_EVERY_MS = 15_000;

export type WorkerHeartbeat = BuildInfo & { beatAt: string; pid: number };

/** O worker não tem HTTP: publica commit/uptime no Redis (com TTL) para o Diagnóstico da API. */
export function startWorkerHeartbeat(redis: HeartbeatRedis, env: EnvLike = process.env, now: () => Date = () => new Date()): () => void {
	const info = buildInfo("worker", env, now(), readRootVersion(env));
	const beat = () => {
		const payload: WorkerHeartbeat = { ...info, beatAt: now().toISOString(), pid: process.pid };
		void redis.set(WORKER_HEARTBEAT_KEY, JSON.stringify(payload), "EX", WORKER_HEARTBEAT_TTL_S).catch(() => undefined);
	};
	beat();
	const timer = setInterval(beat, BEAT_EVERY_MS);
	timer.unref();
	return () => clearInterval(timer);
}

export async function readWorkerHeartbeat(redis: HeartbeatRedis): Promise<WorkerHeartbeat | null> {
	try {
		const raw = await redis.get(WORKER_HEARTBEAT_KEY);
		return raw ? (JSON.parse(raw) as WorkerHeartbeat) : null;
	} catch {
		return null;
	}
}
