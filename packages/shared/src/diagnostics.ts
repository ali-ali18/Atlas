import type { MaintenanceJobStatus } from "./maintenance-status.js";
import type { BuildInfo } from "./build-info.js";

/** Resposta de `GET /v1/diagnostics` (só o dono). Nunca carrega valores de chaves, só presença. */
export type DiagnosticsFailure = {
	kind: "run" | "reflection" | "routine";
	id: string;
	/** Nome curto do que falhou (objetivo do run, nome da rotina, "Reflexão diária"). */
	label: string;
	/** Motivo curto, já sem segredos. */
	reason: string;
	at: string;
};

export type DiagnosticsCheck = { ok: boolean; ms: number | null; error?: string };

export type DiagnosticsQueue = { name: string; waiting: number; active: number; delayed: number; failed: number };

export type DiagnosticsView = {
	generatedAt: string;
	api: BuildInfo & { uptimeSec: number; node: string };
	worker: { up: boolean; version: string | null; commit: string | null; commitShort: string | null; startedAt: string | null; lastBeatAt: string | null };
	services: { postgres: DiagnosticsCheck; redis: DiagnosticsCheck; queues: DiagnosticsQueue[] | null };
	push: { enabled: boolean; problems: string[]; subscriptions: number };
	sentry: { enabled: boolean };
	providers: Array<{ id: string; label: string; present: boolean; source: "server" | "account" | "none" }>;
	env: Array<{ id: string; label: string; configured: boolean; missing: string[] }>;
	failures: DiagnosticsFailure[];
	/** Tarefas em segundo plano (resumo, memória, reflexão, guia): último sucesso e último erro. */
	maintenance?: MaintenanceJobStatus[];
};

const REASON_MAX = 160;

/** Motivo curto de uma falha: uma linha, sem quebra, truncado. */
export function shortReason(text: string | null | undefined, fallback = "sem motivo registrado"): string {
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	if (!flat) return fallback;
	return flat.length > REASON_MAX ? `${flat.slice(0, REASON_MAX - 1).trimEnd()}…` : flat;
}
