import { createHash } from "node:crypto";

/**
 * Teto adaptativo de chamadas por tool de conector MCP.
 *
 * Decisão pura (sem I/O): o runtime consulta `planToolCallExtension` quando
 * uma tool de leitura chega no teto e executa o resultado. Leitura que
 * progride (args distintos, sucesso, orçamento sobrando) ganha mais fôlego;
 * repetição, falha em série ou escrita seguem parando no teto.
 */

/** Teto inicial de tool de leitura de conector. */
export const MCP_READ_TOOL_CALLS_DEFAULT = 40;
/** Teto fixo de tool de escrita de conector. */
export const MCP_WRITE_TOOL_CALLS_DEFAULT = 10;
/** Máximo absoluto a que a extensão automática pode chegar. */
export const MCP_READ_TOOL_CALLS_HARD_CAP = 200;

/** Quantas chamadas recentes por tool entram na decisão (e no checkpoint). */
export const TOOL_CALL_HISTORY_SIZE = 10;
const MIN_DISTINCT_RATIO = 0.8;
const MIN_OK_RATIO = 0.7;
const MIN_BUDGET_LEFT_RATIO = 0.2;
const MIN_EXTENSION = 10;

export type ToolCallRecord = { argsHash: string; ok: boolean };

export type ToolExtensionPlan =
	| { extend: true; newCap: number; reason: string }
	| { extend: false; newCap: number; reason: string };

export function planToolCallExtension(input: {
	readOnly: boolean;
	used: number;
	cap: number;
	recentCalls: readonly ToolCallRecord[];
	hardCap: number;
	/** Teto explícito do bot/run: nunca é ultrapassado. */
	fixedCeiling?: number;
	/** Fração (0..1) do orçamento do run que ainda sobra, a mais restrita. */
	budgetLeftRatio: number;
}): ToolExtensionPlan {
	const { cap } = input;
	const deny = (reason: string): ToolExtensionPlan => ({
		extend: false,
		newCap: cap,
		reason,
	});
	if (!input.readOnly) return deny("write_tool");
	if (input.used < cap) return deny("below_cap");
	const limit = Math.min(input.hardCap, input.fixedCeiling ?? input.hardCap);
	if (cap >= limit) return deny("at_limit");
	if (input.budgetLeftRatio <= MIN_BUDGET_LEFT_RATIO) return deny("low_budget");
	const recent = input.recentCalls.slice(-TOOL_CALL_HISTORY_SIZE);
	if (recent.length === 0) return deny("no_history");
	const distinct = new Set(recent.map((call) => call.argsHash)).size;
	if (distinct / recent.length < MIN_DISTINCT_RATIO) return deny("repeating");
	const oks = recent.filter((call) => call.ok).length;
	if (oks / recent.length < MIN_OK_RATIO) return deny("failing");
	const step = Math.max(MIN_EXTENSION, Math.ceil(cap * 0.5));
	const newCap = Math.min(cap + step, limit);
	return { extend: true, newCap, reason: "progressing" };
}

/** Fração restante do recurso (0..1); `undefined` quando sem limite. */
export function budgetLeftFraction(
	limit: number | undefined,
	used: number,
): number | undefined {
	if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
		return undefined;
	}
	return Math.max(0, Math.min(1, (limit - used) / limit));
}

/** Menor fração restante entre passos, tokens e tempo (os que existirem). */
export function mostConstrainedBudgetRatio(
	fractions: ReadonlyArray<number | undefined>,
): number {
	const known = fractions.filter((value): value is number => value !== undefined);
	return known.length === 0 ? 1 : Math.min(...known);
}

export function pushToolCallRecord(
	history: readonly ToolCallRecord[] | undefined,
	record: ToolCallRecord,
): ToolCallRecord[] {
	return [...(history ?? []), record].slice(-TOOL_CALL_HISTORY_SIZE);
}

/** Hash curto dos args (chave de repetição) — cabe no checkpoint. */
export function hashToolArgs(argsKey: string): string {
	return createHash("sha1").update(argsKey).digest("hex").slice(0, 12);
}
