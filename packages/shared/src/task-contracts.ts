/**
 * Contratos versionados da execução (K1/L13): estado da tarefa, capacidades,
 * efeitos e status estruturado de resultado de tool. Funções puras, sem I/O.
 *
 * Tudo isto vive no checkpoint JSON existente (sem migration) e é lido com
 * parser tolerante: checkpoint antigo (sem estes campos) vira "vazio", nunca
 * erro. Sucesso, autorização e efeito NUNCA são reconstruídos de texto do
 * transcript: vêm destes campos, gravados no momento em que acontecem.
 */

import { parseTaskLedger, type TaskLedger } from "./task-ledger.js";

export const TASK_CONTRACT_VERSION = 1;

// ---- Status estruturado de resultado de tool (L20) -------------------------

export type ToolResultState = "ok" | "error" | "uncertain";
/** none = nada mudou fora do run; applied = escrita confirmada; uncertain = pode ter sido aplicada. */
export type ToolEffect = "none" | "applied" | "uncertain";

export type ToolResultStatus = {
	status: ToolResultState;
	/** Código curto e estável (ex.: `timeout`, `interrupted`); nunca texto livre do provedor. */
	code?: string;
	effect: ToolEffect;
};

const RESULT_STATES: readonly ToolResultState[] = ["ok", "error", "uncertain"];
const EFFECTS: readonly ToolEffect[] = ["none", "applied", "uncertain"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortString(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function nonNegativeInt(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.floor(value))
		: fallback;
}

export function parseToolResultStatus(raw: unknown): ToolResultStatus | null {
	if (!isRecord(raw)) return null;
	const status = RESULT_STATES.find((item) => item === raw.status);
	if (!status) return null;
	const effect = EFFECTS.find((item) => item === raw.effect) ?? "none";
	const code = shortString(raw.code, 60);
	return { status, effect, ...(code ? { code } : {}) };
}

/** Monta o status a partir do que o executor SABE (não do texto do resultado). */
export function buildToolResultStatus(input: {
	ok: boolean;
	/** A tool altera algo fora do run (escrita MCP, arquivo, imagem paga...). */
	writes: boolean;
	/** O executor não sabe se a escrita chegou a ser aplicada (timeout, queda). */
	uncertain?: boolean;
	code?: string;
}): ToolResultStatus {
	const code = shortString(input.code, 60);
	if (input.uncertain) {
		return { status: "uncertain", effect: "uncertain", ...(code ? { code } : {}) };
	}
	if (input.ok) return { status: "ok", effect: input.writes ? "applied" : "none", ...(code ? { code } : {}) };
	return { status: "error", effect: "none", ...(code ? { code } : {}) };
}

/** Sucesso para os contadores de progresso: incerto não é sucesso nem falha conhecida. */
export function isKnownSuccess(status: ToolResultStatus): boolean {
	return status.status === "ok";
}

export const MAX_LEDGER_RESULTS = 200;

/** `tool_call_id` → status estruturado. Mantém só os mais recentes. */
export function parseLedgerResults(raw: unknown): Record<string, ToolResultStatus> {
	if (!isRecord(raw)) return {};
	const entries: Array<[string, ToolResultStatus]> = [];
	for (const [id, value] of Object.entries(raw)) {
		if (!id || id.length > 200) continue;
		const parsed = parseToolResultStatus(value);
		if (parsed) entries.push([id, parsed]);
	}
	return Object.fromEntries(entries.slice(-MAX_LEDGER_RESULTS));
}

// ---- Journal de efeitos (W9) ----------------------------------------------

/** intent = gravado antes da escrita; ok/error = resultado conhecido; uncertain = sem resultado confiável. */
export type EffectState = "intent" | "ok" | "error" | "uncertain";

export type LedgerEffect = {
	attemptId: string;
	tool: string;
	/** Hash dos args normalizados: nunca os args (podem ter dado do usuário). */
	argsHash: string;
	step: number;
	state: EffectState;
	/** Evidência curta e não sensível (ex.: id do artefato, código do erro). */
	evidence?: string;
};

export const MAX_LEDGER_EFFECTS = 60;
const EFFECT_STATES: readonly EffectState[] = ["intent", "ok", "error", "uncertain"];

export function parseLedgerEffects(raw: unknown): LedgerEffect[] {
	if (!Array.isArray(raw)) return [];
	const effects: LedgerEffect[] = [];
	for (const item of raw) {
		if (!isRecord(item)) continue;
		const attemptId = shortString(item.attemptId, 200);
		const tool = shortString(item.tool, 120);
		const state = EFFECT_STATES.find((value) => value === item.state);
		if (!attemptId || !tool || !state) continue;
		const evidence = shortString(item.evidence, 200);
		effects.push({
			attemptId,
			tool,
			argsHash: shortString(item.argsHash, 40) ?? "",
			step: nonNegativeInt(item.step),
			state,
			...(evidence ? { evidence } : {}),
		});
	}
	return effects.slice(-MAX_LEDGER_EFFECTS);
}

/**
 * Efeitos que no resume NÃO podem ser repetidos: intenção sem resultado
 * (queda antes do resultado) ou marcados incertos. Escrita com resultado
 * conhecido não aparece aqui.
 */
export function uncertainEffects(effects: readonly LedgerEffect[]): LedgerEffect[] {
	const latest = new Map<string, LedgerEffect>();
	for (const effect of effects) latest.set(effect.attemptId, effect);
	return [...latest.values()].filter(
		(effect) => effect.state === "intent" || effect.state === "uncertain",
	);
}

// ---- Estado da tarefa (L13/L18) -------------------------------------------

export type TaskPhase = "executing" | "verifying" | "blocked" | "done";
export type TaskCriterionKind = "artifact" | "effect";

export type TaskCriterion = {
	id: string;
	kind: TaskCriterionKind;
	description: string;
	status: "open" | "met";
	/** Evidência que fechou o critério (id de artefato, tool). */
	metBy?: string;
};

export type TaskArtifact = {
	kind: "file" | "image" | "effect";
	ref: string;
	name?: string;
	step: number;
};

export type TaskState = {
	v: 1;
	objective: { text: string; version: number };
	/** Só critérios que a tarefa realmente tem (verificáveis); vazio = nada a exigir. */
	criteria: TaskCriterion[];
	phase: TaskPhase;
	blockers: string[];
	artifacts: TaskArtifact[];
	/** Itens da tarefa (V3): lista explícita, progresso e planejamento. Opcional: checkpoint antigo não tem. */
	ledger?: TaskLedger;
};

export const MAX_TASK_OBJECTIVE_CHARS = 600;
export const MAX_TASK_CRITERIA = 12;
export const MAX_TASK_ARTIFACTS = 40;
export const MAX_TASK_BLOCKERS = 10;

const PHASES: readonly TaskPhase[] = ["executing", "verifying", "blocked", "done"];
const CRITERION_KINDS: readonly TaskCriterionKind[] = ["artifact", "effect"];
const ARTIFACT_KINDS: readonly TaskArtifact["kind"][] = ["file", "image", "effect"];

export function createTaskState(objective: string): TaskState {
	return {
		v: 1,
		objective: { text: objective.trim().slice(0, MAX_TASK_OBJECTIVE_CHARS), version: 1 },
		criteria: [],
		phase: "executing",
		blockers: [],
		artifacts: [],
	};
}

export function parseTaskState(raw: unknown): TaskState | undefined {
	if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.objective)) return undefined;
	const text = typeof raw.objective.text === "string" ? raw.objective.text : "";
	const criteria: TaskCriterion[] = [];
	for (const item of Array.isArray(raw.criteria) ? raw.criteria : []) {
		if (!isRecord(item)) continue;
		const id = shortString(item.id, 80);
		const kind = CRITERION_KINDS.find((value) => value === item.kind);
		if (!id || !kind) continue;
		const metBy = shortString(item.metBy, 200);
		criteria.push({
			id,
			kind,
			description: shortString(item.description, 300) ?? id,
			status: item.status === "met" ? "met" : "open",
			...(metBy ? { metBy } : {}),
		});
	}
	const artifacts: TaskArtifact[] = [];
	for (const item of Array.isArray(raw.artifacts) ? raw.artifacts : []) {
		if (!isRecord(item)) continue;
		const kind = ARTIFACT_KINDS.find((value) => value === item.kind);
		const ref = shortString(item.ref, 200);
		if (!kind || !ref) continue;
		const name = shortString(item.name, 200);
		artifacts.push({ kind, ref, step: nonNegativeInt(item.step), ...(name ? { name } : {}) });
	}
	const ledger = parseTaskLedger(raw.ledger);
	return {
		v: 1,
		objective: {
			text: text.slice(0, MAX_TASK_OBJECTIVE_CHARS),
			version: Math.max(1, nonNegativeInt(raw.objective.version, 1)),
		},
		criteria: criteria.slice(0, MAX_TASK_CRITERIA),
		phase: PHASES.find((value) => value === raw.phase) ?? "executing",
		blockers: (Array.isArray(raw.blockers) ? raw.blockers : [])
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.slice(0, 200))
			.slice(-MAX_TASK_BLOCKERS),
		artifacts: artifacts.slice(-MAX_TASK_ARTIFACTS),
		...(ledger ? { ledger } : {}),
	};
}

export function unmetCriteria(state: Pick<TaskState, "criteria">): TaskCriterion[] {
	return state.criteria.filter((criterion) => criterion.status === "open");
}

// ---- Capacidades (K1) ------------------------------------------------------

export type CapabilitySnapshot = {
	v: 1;
	/** Tools realmente executáveis agora (as que o modelo recebeu). */
	tools: string[];
	/** O modelo do run aceita imagens. */
	vision: boolean;
	/** Restrições efetivas em frases curtas (ex.: `read-only connectors`). */
	restrictions: string[];
};

export const MAX_CAPABILITY_TOOLS = 200;

export function createCapabilitySnapshot(input: {
	tools: readonly string[];
	vision: boolean;
	restrictions?: readonly string[];
}): CapabilitySnapshot {
	return {
		v: 1,
		tools: [...new Set(input.tools)].slice(0, MAX_CAPABILITY_TOOLS),
		vision: input.vision,
		restrictions: [...new Set(input.restrictions ?? [])].slice(0, 10),
	};
}

export function parseCapabilitySnapshot(raw: unknown): CapabilitySnapshot | undefined {
	if (!isRecord(raw) || raw.v !== 1 || !Array.isArray(raw.tools)) return undefined;
	const strings = (value: unknown, max: number, each: number): string[] =>
		(Array.isArray(value) ? value : [])
			.filter((item): item is string => typeof item === "string" && item.length > 0)
			.map((item) => item.slice(0, each))
			.slice(0, max);
	return {
		v: 1,
		tools: strings(raw.tools, MAX_CAPABILITY_TOOLS, 120),
		vision: raw.vision === true,
		restrictions: strings(raw.restrictions, 10, 120),
	};
}

// ---- Fim do stream (L18) ---------------------------------------------------

/**
 * Motivo normalizado de término da geração. `incomplete` = o stream acabou sem
 * `finish_reason` (EOF não é parada normal). Ausente (undefined) = origem que
 * não informa o motivo (mock, provedor legado): tratado como normal.
 */
export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error" | "incomplete";

export type FinishClass = "normal" | "truncated" | "refusal" | "incomplete";

export function normalizeFinishReason(raw: unknown): FinishReason {
	switch (raw) {
		case "stop":
		case "end_turn":
		case "STOP":
			return "stop";
		case "tool_calls":
		case "tool_use":
		case "function_call":
			return "tool_calls";
		case "length":
		case "max_tokens":
		case "MAX_TOKENS":
			return "length";
		case "content_filter":
		case "refusal":
		case "SAFETY":
			return "content_filter";
		case "error":
			return "error";
		default:
			return "incomplete";
	}
}

export function classifyFinish(reason: FinishReason | undefined): FinishClass {
	if (reason === undefined) return "normal";
	if (reason === "stop" || reason === "tool_calls") return "normal";
	if (reason === "length") return "truncated";
	if (reason === "content_filter") return "refusal";
	return "incomplete";
}
