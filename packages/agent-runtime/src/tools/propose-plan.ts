import type { ChatTool } from "@workspace/llm";
import { DEV_APPROVAL_TTL_MS, saveSkillPendingIntent } from "@workspace/db";
import { PLAN_MAX_STEPS, PLAN_PENDING_RESULT, normalizePlanInput, type PlanInfo } from "@workspace/shared";

/**
 * `propose_plan`: antes de uma tarefa grande (vários passos que mudam dados em conectores, enviam algo ou demoram)
 * o bot mostra os passos e espera o "Aprovar plano". O run para no cartão (como um cartão de aprovação); a decisão
 * volta como resultado desta chamada. Aprovar o plano NÃO aprova escritas: cada escrita segue a autonomia e as
 * confirmações de sempre. Enquanto o plano espera, o código bloqueia escritas (ver `hooks/pre-tool.ts`).
 */

export const PROPOSE_PLAN_TOOL_NAME = "propose_plan";

export const PROPOSE_PLAN_TOOL: ChatTool = {
	type: "function",
	function: {
		name: PROPOSE_PLAN_TOOL_NAME,
		description:
			"Shows the user a short plan and waits for their approval before you act. " +
			"USE WHEN the task has several steps that change data in connectors, send something to other people, or will take long, and a wrong start would be costly to undo. " +
			"DO NOT USE for a simple question, a single lookup, or a small task you can just do. " +
			"Read steps (lookups) are allowed before and after proposing; do not run write tools until the plan is approved. " +
			"List what you still need from the user in `needs` instead of asking in text. Approving the plan does not approve individual writes: each write still asks as usual. " +
			"After calling it, stop and wait; do not repeat the plan in text.",
		parameters: {
			type: "object",
			properties: {
				title: { type: "string", description: "Short name of the plan." },
				steps: {
					type: "array",
					description: `Ordered steps, at most ${PLAN_MAX_STEPS}, each one short.`,
					items: {
						type: "object",
						properties: {
							text: { type: "string", description: "What the step does." },
							kind: { type: "string", enum: ["read", "write", "ask", "other"], description: "read = lookup, write = changes data or sends something, ask = needs the user, other." },
						},
						required: ["text", "kind"],
					},
				},
				needs: { type: "array", items: { type: "string" }, description: "Information you still need from the user." },
				risks: { type: "string", description: "What could go wrong or cannot be undone, if relevant." },
			},
			required: ["title", "steps"],
		},
	},
};

export type ProposePlanContext = {
	userId?: string;
	botId?: string | null;
	conversationId?: string;
	runId?: string;
	origin?: string;
	/** Marca o plano como pendente neste run (o portão de escritas). */
	markPending?: (plan: PlanInfo) => void;
	persistCard?: (conversationId: string, card: PlanConfirmCard) => Promise<unknown>;
	saveIntent?: typeof saveSkillPendingIntent;
};

export type PlanConfirmCard = {
	type: "confirm";
	confirmId: string;
	title: string;
	description?: string;
	confirmLabel: string;
	cancelLabel: string;
	plan: PlanInfo;
};

/** Id do cartão do plano: o run que perguntou fica no fim (a API o usa para encaixar a decisão na conversa dele). */
export function planConfirmId(runId: string | undefined): string {
	return `confirm-plan-${runId ?? "local"}`;
}

export async function executeProposePlan(args: Record<string, unknown>, ctx: ProposePlanContext): Promise<{ summary: string; confirmEvent: PlanConfirmCard; plan: PlanInfo }> {
	const plan = normalizePlanInput(args);
	if (ctx.origin !== "chat" || !ctx.conversationId) throw new Error("propose_plan needs a chat with the user; do the task directly or explain what you would do.");
	const confirmId = planConfirmId(ctx.runId);
	await (ctx.saveIntent ?? saveSkillPendingIntent)({
		userId: ctx.userId ?? "default",
		conversationId: ctx.conversationId,
		ttlMs: DEV_APPROVAL_TTL_MS,
		payload: { kind: "confirm", action: "plan", confirmId, ...(ctx.botId ? { botId: ctx.botId } : {}), plan },
	});
	const card: PlanConfirmCard = {
		type: "confirm",
		confirmId,
		title: plan.title,
		confirmLabel: "Aprovar plano",
		cancelLabel: "Cancelar",
		plan,
	};
	await ctx.persistCard?.(ctx.conversationId, card).catch(() => undefined);
	ctx.markPending?.(plan);
	return { summary: `${PLAN_PENDING_RESULT} Stop here and wait; do not run write tools until the user decides.`, confirmEvent: card, plan };
}
