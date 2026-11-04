import { z } from "zod";
import { cancelConversationReturn, createConversationReturn, ConversationReturnLimitError, listPendingReturns } from "@workspace/db";
import { formatReturnMarker, planScheduleReturn, type ComputerUseEvent, type OwnerWaitTimeoutJobPayload } from "@workspace/shared";
import { defineTool, type DefinedTool } from "./define-tool.js";
import type { ToolContext, ToolResult } from "./registry/types.js";

export const SCHEDULE_RETURN_TOOL_NAME = "schedule_return";

/**
 * Filas do "esperar o dono" (motor v3, PR8a): o worker injeta (BullMQ, jobs atrasados). Sem isto a tool falha com
 * erro honesto e o prazo do cartão não é agendado (o cartão espera sem prazo, e o modelo é avisado).
 */
export type OwnerWaitDeps = {
	scheduleTimeout: (payload: OwnerWaitTimeoutJobPayload) => Promise<void>;
	scheduleReturn: (input: { userId: string; returnId: string; delayMs: number }) => Promise<void>;
	/** Cancela o job do retorno (o agendamento falhou depois de gravar). */
	cancelReturn?: (returnId: string) => Promise<void>;
	now?: () => Date;
};

export type ReturnScheduledEvent = Extract<ComputerUseEvent, { type: "return_scheduled" }>;

/** Banco do retorno (testes injetam um falso). */
export type ScheduleReturnStore = {
	listPending: typeof listPendingReturns;
	create: typeof createConversationReturn;
	cancel: typeof cancelConversationReturn;
};

/** Lido na hora da chamada (o módulo do banco pode vir dublado nos testes). */
const DEFAULT_STORE: ScheduleReturnStore = {
	listPending: (...args) => listPendingReturns(...args),
	create: (...args) => createConversationReturn(...args),
	cancel: (...args) => cancelConversationReturn(...args),
};

const input = z.object({
	at: z.string().optional().describe("When to come back: ISO date-time with timezone offset (e.g. 2026-11-04T15:30:00-03:00). Use this OR inMinutes."),
	inMinutes: z.number().optional().describe("Minutes from now (1 to 10080). Use this OR at."),
	reason: z.string().describe("One short sentence: what you will check or do when you come back."),
	visible: z.boolean().optional().describe("true when you promised the user to come back (shows 'back at HH:MM', the user can cancel); false (default) for a follow-up you decided yourself: you only post if there is news."),
});

export async function executeScheduleReturn(args: z.output<typeof input>, ctx: ToolContext, store: ScheduleReturnStore = DEFAULT_STORE): Promise<ToolResult> {
	const deps = ctx.ownerWait;
	if (!deps) throw new Error("Scheduling a return is not available in this run. Tell the user when to check back, or propose a routine.");
	if (!ctx.conversationId || !ctx.userId || ctx.userId === "default" || !ctx.runId) throw new Error("Scheduling a return needs a conversation; there is none in this run.");
	const now = deps.now?.() ?? new Date();
	const pending = await store.listPending(ctx.userId, ctx.conversationId);
	const plan = planScheduleReturn({ at: args.at, inMinutes: args.inMinutes, reason: args.reason, visible: args.visible, now, pending: pending.length });
	if (!plan.ok) throw new Error(plan.error);
	let record;
	try {
		record = await store.create({ userId: ctx.userId, botId: ctx.botId ?? null, conversationId: ctx.conversationId, sourceRunId: ctx.runId, dueAt: plan.dueAt, reason: plan.reason, visible: plan.visible });
	} catch (error) {
		if (error instanceof ConversationReturnLimitError) throw new Error("This conversation already has 3 pending returns (the maximum). Use one of them, or cancel one first.");
		throw error;
	}
	try {
		await deps.scheduleReturn({ userId: ctx.userId, returnId: record.id, delayMs: plan.delayMs });
	} catch (error) {
		// Sem job a linha nunca dispararia e ocuparia uma das 3 vagas: sai junto.
		await store.cancel(ctx.userId, record.id, ctx.conversationId).catch(() => null);
		await deps.cancelReturn?.(record.id).catch(() => undefined);
		throw new Error(`Could not schedule the return (${error instanceof Error ? error.message : String(error)}). Nothing was scheduled; tell the user when to check back instead.`);
	}
	const label = formatReturnMarker(plan.dueAt, now, ctx.timeZone);
	const returnEvent: ReturnScheduledEvent | undefined = plan.visible
		? { type: "return_scheduled", returnId: record.id, at: plan.dueAt.toISOString(), label, reason: plan.reason, status: "pending" }
		: undefined;
	const when = plan.dueAt.toISOString();
	return {
		summary: plan.visible
			? `Return scheduled for ${when} (id ${record.id}; the user sees "${label}" and can cancel it). This conversation continues then with its context. Tell the user in a few words; do not schedule the same again.`
			: `Silent return scheduled for ${when} (id ${record.id}). When it runs you will post only if there is news. Do not mention it to the user unless they asked.`,
		...(returnEvent ? { returnEvent } : {}),
	};
}

/**
 * `schedule_return` (motor v3, "Volto depois" do dono, 03/11): despertador de UMA vez que retoma esta conversa.
 * Não é rotina nem item da Biblioteca; conferência que se repete continua sendo rotina (intervalo mínimo de 2 h).
 */
export const SCHEDULE_RETURN_DEFINED: DefinedTool = defineTool({
	name: SCHEDULE_RETURN_TOOL_NAME,
	description:
		"Come back to THIS conversation once, later, with its context (1 minute to 7 days; at most 3 pending per conversation). USE WHEN you promised the user to check back (visible=true), or to follow up once on something that finishes later (a deploy, a delivery, a reply) (visible=false: you post only if there is news). DO NOT USE for repeated checks or anything recurring (propose a routine), or to wait a few seconds (use the wait tools).",
	input,
	effect: "write_internal",
	group: "proactive",
	run: (args, ctx) => executeScheduleReturn(args, ctx),
});

export const CANCEL_RETURN_TOOL_NAME = "cancel_return";

const cancelInput = z.object({ returnId: z.string().min(1).describe("Id of the pending return (from schedule_return or the pending-returns note).") });

export async function executeCancelReturn(args: z.output<typeof cancelInput>, ctx: ToolContext, store: ScheduleReturnStore = DEFAULT_STORE): Promise<ToolResult> {
	if (!ctx.conversationId || !ctx.userId || ctx.userId === "default") throw new Error("There is no conversation in this run.");
	const cancelled = await store.cancel(ctx.userId, args.returnId, ctx.conversationId);
	if (!cancelled) throw new Error("No pending return with this id in this conversation (it may have already run or been cancelled).");
	await ctx.ownerWait?.cancelReturn?.(cancelled.id).catch(() => undefined);
	return {
		summary: `Return ${cancelled.id} cancelled.`,
		...(cancelled.visible ? { returnEvent: { type: "return_scheduled" as const, returnId: cancelled.id, at: cancelled.dueAt.toISOString(), label: "Retorno cancelado", reason: cancelled.reason, status: "cancelled" as const } } : {}),
	};
}

/** `cancel_return`: o mesmo que o "cancelar" do marcador, pelo chat (agent-first). */
export const CANCEL_RETURN_DEFINED: DefinedTool = defineTool({
	name: CANCEL_RETURN_TOOL_NAME,
	description: "Cancel a pending return of this conversation (scheduled with schedule_return). USE WHEN the user asks to cancel it or it is no longer needed. DO NOT USE for routines or reminders.",
	input: cancelInput,
	effect: "write_internal",
	group: "proactive",
	run: (args, ctx) => executeCancelReturn(args, ctx),
});
