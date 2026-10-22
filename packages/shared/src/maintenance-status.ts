import { shortReason } from "./diagnostics.js";
import { scrubString } from "./scrub.js";

/** Tarefas em segundo plano que usam o modelo de manutenção e aparecem no Diagnóstico. */
export const MAINTENANCE_JOB_KINDS = ["summary", "memory-review", "reflection", "connector-guide", "reviewer", "memory-gate", "lesson-review", "skill-review"] as const;
export type MaintenanceJobKind = (typeof MAINTENANCE_JOB_KINDS)[number];

export const MAINTENANCE_JOB_LABEL: Record<MaintenanceJobKind, string> = {
	summary: "Resumo de conversa",
	"memory-review": "Revisão de memória",
	reflection: "Reflexão",
	"connector-guide": "Guia do conector",
	reviewer: "Revisor",
	"memory-gate": "Porteiro da memória",
	"lesson-review": "Revisão de lições",
	"skill-review": "Revisão de skills",
};

export type MaintenanceJobStatus = {
	kind: MaintenanceJobKind;
	lastSuccessAt: string | null;
	lastError: { message: string; at: string } | null;
};

/** Guardado em `user_settings.maintenanceStatusJson`: só horários e um texto curto já limpo, nunca segredo. */
export type MaintenanceStatusStore = Partial<Record<MaintenanceJobKind, { successAt?: string; error?: { message: string; at: string } }>>;

const ERROR_MAX = 200;

/** Mensagem curta, em uma linha e sem credenciais, para o painel. */
export function friendlyMaintenanceError(error: unknown): string {
	const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return shortReason(scrubString(raw), "falha sem detalhe").slice(0, ERROR_MAX);
}

const isIso = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));

/** Lê o JSON do banco com tolerância: o que não for válido some. */
export function parseMaintenanceStatus(json: unknown): MaintenanceStatusStore {
	if (!json || typeof json !== "object" || Array.isArray(json)) return {};
	const out: MaintenanceStatusStore = {};
	for (const kind of MAINTENANCE_JOB_KINDS) {
		const entry = (json as Record<string, unknown>)[kind];
		if (!entry || typeof entry !== "object") continue;
		const { successAt, error } = entry as { successAt?: unknown; error?: unknown };
		const next: NonNullable<MaintenanceStatusStore[MaintenanceJobKind]> = {};
		if (isIso(successAt)) next.successAt = successAt;
		if (error && typeof error === "object") {
			const { message, at } = error as { message?: unknown; at?: unknown };
			if (typeof message === "string" && isIso(at)) next.error = { message: message.slice(0, ERROR_MAX), at };
		}
		if (next.successAt || next.error) out[kind] = next;
	}
	return out;
}

/** Aplica um resultado: sucesso limpa o erro mais antigo que ele; falha mantém o último sucesso. */
export function applyMaintenanceResult(store: MaintenanceStatusStore, kind: MaintenanceJobKind, result: { ok: true; at: Date } | { ok: false; at: Date; message: string }): MaintenanceStatusStore {
	const current = store[kind] ?? {};
	const at = result.at.toISOString();
	const next = result.ok ? { ...current, successAt: at } : { ...current, error: { message: result.message.slice(0, ERROR_MAX), at } };
	return { ...store, [kind]: next };
}

export function maintenanceStatusView(store: MaintenanceStatusStore): MaintenanceJobStatus[] {
	return MAINTENANCE_JOB_KINDS.map((kind) => ({ kind, lastSuccessAt: store[kind]?.successAt ?? null, lastError: store[kind]?.error ?? null }));
}
