import { z } from "zod";
import { updateRoutine } from "@workspace/db";
import { ROUTINE_MAX_COST_MAX_USD, ROUTINE_MAX_COST_MIN_USD, ROUTINE_MAX_STEPS_MAX, ROUTINE_MAX_STEPS_MIN, formatRoutineLimitsSummary, parseRoutineLimitsInput, type RoutineRecord } from "@workspace/shared";
import { defineTool, type DefinedTool } from "./define-tool.js";
import { skillScope } from "./registry/helpers.js";
import { resolveRoutineTarget } from "./registry/handlers/routines.js";
import type { RoutineEvent, ToolContext, ToolResult } from "./registry/types.js";

export const ROUTINE_LIMITS_TOOL_NAME = "routine_limits";

/**
 * `routine_limits` (motor v3, PR8b, decisão D4): o dono sobe (ou volta ao padrão) os passos e o US$ por execução de uma
 * rotina pelo chat, como faz pela API da rotina. Precisa de humano (`needsHuman`): a rotina nunca aumenta o próprio teto.
 * Validação e faixas em `packages/shared` (`parseRoutineLimitsInput`), as mesmas da API.
 */
export type RoutineLimitsStore = {
	resolve: (scope: { userId: string; botId: string }, target: string) => ReturnType<typeof resolveRoutineTarget>;
	update: (scope: { userId: string; botId: string }, routineId: string, limits: NonNullable<Parameters<typeof updateRoutine>[3]["limits"]> | null) => Promise<RoutineRecord | null>;
};

const DEFAULT_STORE: RoutineLimitsStore = {
	resolve: (scope, target) => resolveRoutineTarget(scope, target),
	update: (scope, routineId, limits) => updateRoutine(scope.userId, scope.botId, routineId, { limits }),
};

const FIELDS = ["maxSteps", "maxCostUsd"] as const;

const input = z.object({
	target: z.string().min(1).max(200).describe("Routine name or id (from list_routines)."),
	maxSteps: z.number().optional().describe(`Steps per run (${ROUTINE_MAX_STEPS_MIN} to ${ROUTINE_MAX_STEPS_MAX}). Default without it: 40.`),
	maxCostUsd: z.number().optional().describe(`Max US$ per run (${ROUTINE_MAX_COST_MIN_USD} to ${ROUTINE_MAX_COST_MAX_USD}). No default: without it there is no US$ cap.`),
	reset: z.array(z.enum(FIELDS)).optional().describe("Fields to put back to the default (maxSteps → 40 steps, maxCostUsd → no US$ cap)."),
});

export async function executeRoutineLimits(args: z.output<typeof input>, ctx: ToolContext, store: RoutineLimitsStore = DEFAULT_STORE): Promise<ToolResult> {
	const scope = skillScope(ctx);
	if (!scope || scope.userId === "default") throw new Error("Routines are not available in this run (no bot or owner).");
	const reset = new Set(args.reset ?? []);
	const raw: Record<string, number | null> = {};
	for (const field of FIELDS) {
		if (reset.has(field) && args[field] !== undefined) throw new Error(`${field} is both set and reset; choose one.`);
		if (reset.has(field)) raw[field] = null;
		else if (args[field] !== undefined) raw[field] = args[field];
	}
	if (Object.keys(raw).length === 0) throw new Error(`Nothing to change: pass maxSteps, maxCostUsd or reset. Accepted fields: ${FIELDS.join(", ")}, reset.`);
	const parsed = parseRoutineLimitsInput(raw);
	if (!parsed.ok) throw new Error(parsed.error);
	const found = await store.resolve(scope, args.target.trim());
	if (found.kind === "none") throw new Error(`No routine like "${args.target.slice(0, 80)}" for this bot. Use list_routines.`);
	if (found.kind === "ambiguous") throw new Error(`More than one routine matches:\n${found.lines}\nAsk the user which one.`);
	const updated = await store.update(scope, found.routine.id, parsed.patch);
	if (!updated) throw new Error("Could not update the routine now. Try again.");
	const sentence = formatRoutineLimitsSummary(updated.limits);
	const routineEvent: RoutineEvent = { type: "routine", action: "updated", routineId: updated.id, title: updated.name, triggerType: updated.triggerType, detail: sentence };
	return { summary: `Routine "${updated.name}" limits saved: ${sentence}. Tell the user in one short sentence.`, routineEvent };
}

export const ROUTINE_LIMITS_DEFINED: DefinedTool = defineTool({
	name: ROUTINE_LIMITS_TOOL_NAME,
	description:
		"Change how far one run of a routine may go before it stops and asks the owner \"continue?\": steps per run and an optional US$ cap. USE WHEN the owner asks to raise, lower or reset a routine's step or spending limit. DO NOT USE for the schedule, the instruction or pausing (use the routine tools).",
	input,
	effect: "write_internal",
	needsHuman: true,
	group: "routines",
	run: (args, ctx) => executeRoutineLimits(args, ctx),
});
