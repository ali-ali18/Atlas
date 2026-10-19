import { Hono } from "hono";
import {
	envGroupStatus,
	readVapidConfig,
	scrubString,
	shortReason,
	vapidProblems,
	type BuildInfo,
	type DiagnosticsCheck,
	type DiagnosticsFailure,
	type DiagnosticsQueue,
	type DiagnosticsView,
	type MaintenanceJobStatus,
	type EnvLike,
} from "@workspace/shared";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

/**
 * `GET /v1/diagnostics` — só para o dono. Versões (api/worker), saúde do Postgres/Redis/filas,
 * push, chaves de provedores (presença, nunca o valor) e as últimas falhas com motivo curto.
 * Cada leitura falha sozinha: um serviço fora do ar aparece como "fora", não derruba a tela.
 */
export type DiagnosticsDeps = {
	env: EnvLike;
	now: () => Date;
	build: BuildInfo;
	isOwner: (email: string) => Promise<boolean> | boolean;
	pingDb: () => Promise<DiagnosticsCheck>;
	pingRedis: () => Promise<DiagnosticsCheck>;
	queues: () => Promise<DiagnosticsQueue[] | null>;
	worker: () => Promise<{ version: string; commit: string; commitShort: string; startedAt: string; beatAt: string } | null>;
	pushSubscriptions: (userId: string) => Promise<number>;
	accountProviders: (userId: string) => Promise<Array<{ id: string; label: string; present: boolean }>>;
	failures: (userId: string, limit: number) => Promise<DiagnosticsFailure[]>;
	sentryEnabled: () => boolean;
	/** Último sucesso/erro das tarefas em segundo plano (resumo, memória, reflexão, guia). */
	maintenance?: (userId: string) => Promise<MaintenanceJobStatus[]>;
};

async function settle<T>(promise: Promise<T>, fallback: T): Promise<T> {
	try {
		return await promise;
	} catch {
		return fallback;
	}
}

export async function buildDiagnostics(userId: string, deps: DiagnosticsDeps): Promise<DiagnosticsView> {
	const now = deps.now();
	const [db, redis, queues, worker, subs, account, failures, maintenance] = await Promise.all([
		settle(deps.pingDb(), { ok: false, ms: null, error: "sem resposta" }),
		settle(deps.pingRedis(), { ok: false, ms: null, error: "sem resposta" }),
		settle(deps.queues(), null),
		settle(deps.worker(), null),
		settle(deps.pushSubscriptions(userId), 0),
		settle(deps.accountProviders(userId), []),
		settle(deps.failures(userId, 10), []),
		settle(deps.maintenance?.(userId) ?? Promise.resolve([]), []),
	]);
	const vapid = readVapidConfig(deps.env);
	const serverKey = Boolean(deps.env.OPENROUTER_API_KEY?.trim());
	const accountOpenRouter = account.find((item) => item.id === "openrouter");
	const providers: DiagnosticsView["providers"] = [
		{ id: "openrouter", label: "OpenRouter", present: serverKey || Boolean(accountOpenRouter?.present), source: serverKey ? "server" : accountOpenRouter?.present ? "account" : "none" },
		...account
			.filter((item) => item.id !== "openrouter")
			.map((item) => ({ id: item.id, label: item.label, present: item.present, source: item.present ? ("account" as const) : ("none" as const) })),
	];
	return {
		generatedAt: now.toISOString(),
		api: { ...deps.build, uptimeSec: Math.max(0, Math.round((now.getTime() - new Date(deps.build.startedAt).getTime()) / 1000)), node: process.version },
		worker: worker
			? { up: true, version: worker.version || null, commit: worker.commit, commitShort: worker.commitShort, startedAt: worker.startedAt, lastBeatAt: worker.beatAt }
			: { up: false, version: null, commit: null, commitShort: null, startedAt: null, lastBeatAt: null },
		services: { postgres: db, redis, queues },
		push: { enabled: Boolean(vapid), problems: vapid ? [] : vapidProblems(deps.env), subscriptions: subs },
		sentry: { enabled: deps.sentryEnabled() },
		providers,
		env: envGroupStatus(deps.env),
		maintenance: maintenance.map((job) => ({
			kind: job.kind,
			lastSuccessAt: job.lastSuccessAt,
			lastError: job.lastError ? { at: job.lastError.at, message: shortReason(scrubString(job.lastError.message)) } : null,
		})),
		failures: failures.map((item) => ({ ...item, label: shortReason(scrubString(item.label)), reason: shortReason(scrubString(item.reason)) })),
	};
}

export function createDiagnosticsRoutes(deps: DiagnosticsDeps) {
	const app = new Hono<AuthEnv>();
	app.get("/v1/diagnostics", async (c) => {
		const session = c.get("session");
		if (!(await deps.isOwner(session.user.email))) return c.json({ error: "Forbidden" }, 403);
		try {
			return c.json(await buildDiagnostics(scopeFor(session).userId, deps));
		} catch (error) {
			console.error("diagnostics failed", error);
			return c.json({ error: "Não foi possível montar o diagnóstico." }, 503);
		}
	});
	return app;
}
