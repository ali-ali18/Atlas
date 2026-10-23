import { createHash } from "node:crypto";
import {
	MAX_LEDGER_EFFECTS,
	MAX_LEDGER_RESULTS,
	parseLedgerEffects,
	parseLedgerResults,
	uncertainEffects,
	type EffectState,
	type LedgerEffect,
	type ToolResultStatus,
} from "@workspace/shared";

/**
 * Journal de efeitos (W9). Mantém, por tentativa, o estado da escrita externa
 * (intenção -> ok | erro | incerto) e o status estruturado por `tool_call_id`
 * (L20). Os dados vão no `executionLedger` do checkpoint; a fonte durável da
 * intenção é o passo `running` com `attemptId` (ver `findStartedToolStep`).
 */

/** Tools nativas com efeito fora do run (além das escritas MCP). */
export const EFFECTFUL_NATIVE_TOOLS: ReadonlySet<string> = new Set([
	"create_file",
	"generate_image",
	"propose_routine",
	"routine_group",
	"page_create",
	"page_update",
	"page_share",
]);

export function isJournaledWrite(name: string, mcpEntry?: { readOnly: boolean }): boolean {
	return mcpEntry ? !mcpEntry.readOnly : EFFECTFUL_NATIVE_TOOLS.has(name);
}

/** Hash dos args (ordem das chaves não conta). Nunca guarda os args em si. */
export function hashEffectArgs(args: Record<string, unknown>): string {
	const sorted = Object.keys(args)
		.sort()
		.map((key) => [key, args[key]]);
	return createHash("sha1").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}

/** A escrita pode ter sido aplicada, mas o executor não sabe (timeout, queda). */
export class ToolEffectUncertainError extends Error {
	readonly code: string;
	constructor(message: string, code = "uncertain") {
		super(message);
		this.name = "ToolEffectUncertainError";
		this.code = code;
	}
}

/** Nota ao modelo (neutra) quando a escrita não tem resultado conhecido. */
export const INTERRUPTED_WRITE_NOTE =
	"This write was started before the run was interrupted and its result was never recorded, so it may or may not have been applied. It was not repeated. Check the current state (read or list the resource) before trying again, or ask the user; only repeat it if the change is missing.";

export type EffectJournal = ReturnType<typeof createEffectJournal>;

export function createEffectJournal(initial?: { effects?: unknown; results?: unknown } | null) {
	let effects = parseLedgerEffects(initial?.effects);
	const results: Record<string, ToolResultStatus> = parseLedgerResults(initial?.results);

	const upsert = (effect: LedgerEffect) => {
		effects = effects.filter((item) => item.attemptId !== effect.attemptId);
		effects.push(effect);
		if (effects.length > MAX_LEDGER_EFFECTS) effects = effects.slice(-MAX_LEDGER_EFFECTS);
	};

	return {
		intent(input: { attemptId: string; tool: string; argsHash: string; step: number }) {
			upsert({ ...input, state: "intent" });
		},
		settle(attemptId: string, state: Exclude<EffectState, "intent">, evidence?: string) {
			const current = effects.find((item) => item.attemptId === attemptId);
			if (!current) return;
			upsert({ ...current, state, ...(evidence ? { evidence: evidence.slice(0, 200) } : {}) });
		},
		recordResult(callId: string, status: ToolResultStatus) {
			delete results[callId];
			results[callId] = status;
			const keys = Object.keys(results);
			for (const key of keys.slice(0, Math.max(0, keys.length - MAX_LEDGER_RESULTS))) delete results[key];
		},
		resultOf(callId: string): ToolResultStatus | undefined {
			return results[callId];
		},
		uncertain(): LedgerEffect[] {
			return uncertainEffects(effects);
		},
		snapshot(): { effects: LedgerEffect[]; results: Record<string, ToolResultStatus> } {
			return { effects: structuredClone(effects), results: structuredClone(results) };
		},
	};
}
