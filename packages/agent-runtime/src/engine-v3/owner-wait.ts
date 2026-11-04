import { listPendingReturns } from "@workspace/db";
import { ownerWaitResultText, parseWaitMinutes, pendingReturnsNote, type OwnerWaitCardKind } from "@workspace/shared";
import type { ChatTool } from "@workspace/llm";
import type { V3Run } from "./state.js";

/**
 * "Esperar o dono" no motor v3 (PR8a). Toda tool que estaciona esperando o dono (cartão de aprovação, questionário,
 * login/VM) tem saídas que o MODELO recebe como resultado da tool: feito, assumiu, pulou, prazo vencido, ignorou
 * (mandou outra mensagem) ou recusou. O pedido recusado/pulado não volta no mesmo trabalho (`ownerRefused`).
 */

/** Campo de prazo que o modelo pode mandar em qualquer chamada que estaciona; nunca vai ao executor nem à chave da chamada. */
export const WAIT_ARG = "waitMinutes";

/**
 * Tira `waitMinutes` dos args. Tool que declara o campo no próprio schema fica com ele (nenhuma nativa declara hoje).
 * Valor fora de 1–1440 = erro honesto com o aceito.
 */
export function takeWaitMinutes(tool: ChatTool, args: Record<string, unknown>): { args: Record<string, unknown>; minutes?: number } | { error: string } {
	if (!(WAIT_ARG in args) || WAIT_ARG in (tool.function.parameters.properties ?? {})) return { args };
	const { [WAIT_ARG]: raw, ...rest } = args;
	const parsed = parseWaitMinutes(raw);
	if (!parsed.ok) return { error: parsed.error };
	return { args: rest, ...(parsed.minutes !== undefined ? { minutes: parsed.minutes } : {}) };
}

/** Chaves do que o dono recusou/pulou/ignorou neste trabalho (vão para a continuação pela semente e pelo checkpoint). */
export const refusedCallKey = (callKey: string) => `call:${callKey}`;
export const refusedToolKey = (name: string) => `tool:${name}`;

export function alreadyRefusedMessage(what: string): string {
	return `The owner already declined, skipped or did not answer this request (${what}) in this task, so it was not asked again. Continue the rest without it and say in one line what was left out.`;
}

export const OWNER_HAS_COMPUTER = "The owner has control of the computer right now: computer tools (browser, screen, its shell) do not run in this turn. Continue with what does not need it, or end your turn saying you are waiting for them.";

export const NO_DEADLINE_NOTE = "(No deadline could be set here: the card waits without one.)";

/**
 * Agenda o prazo do cartão (job atrasado; o dono que responde antes o cancela). Devolve o ISO do prazo, ou `undefined`
 * sem as filas ou sem conversa (aí o cartão espera sem prazo e o resultado avisa o modelo).
 */
export async function scheduleCardDeadline(
	run: V3Run,
	input: { card: OwnerWaitCardKind; cardId: string; toolName?: string; what: string; minutes: number },
): Promise<string | undefined> {
	const deps = run.params.ownerWait;
	if (!deps || !run.conversationId || run.userId === "default") return undefined;
	const now = deps.now?.() ?? new Date();
	try {
		await deps.scheduleTimeout({
			kind: "card_timeout",
			userId: run.userId,
			conversationId: run.conversationId,
			runId: run.runId,
			card: input.card,
			cardId: input.cardId,
			...(input.toolName ? { toolName: input.toolName } : {}),
			what: input.what.slice(0, 300),
			minutes: input.minutes,
		});
	} catch {
		return undefined;
	}
	return new Date(now.getTime() + input.minutes * 60_000).toISOString();
}

/** Login/VM retomado: o texto que o modelo recebe pela saída que o dono escolheu (ou por ter mandado outra mensagem). */
export function loginResumeText(input: { outcome: "takeover" | "skipped" | "skipped_timeout" | "ignored"; site: string; what?: string; message?: string; minutes?: number }): string {
	const what = input.what ?? `log in to ${input.site}`;
	return `[runtime] ${ownerWaitResultText(input.outcome, { what, ...(input.message !== undefined ? { message: input.message } : {}), ...(input.minutes ? { minutes: input.minutes } : {}) })}`;
}

/** Nota do turno com os retornos pendentes (o modelo não agenda de novo nem duplica o que já vai fazer). */
export async function pendingReturnsTurnNote(params: { userId?: string; conversationId?: string }, list: typeof listPendingReturns = listPendingReturns): Promise<string> {
	if (!params.userId || !params.conversationId || params.userId === "default") return "";
	const pending = await list(params.userId, params.conversationId).catch(() => []);
	return pendingReturnsNote(pending.map((item) => ({ dueAt: item.dueAt, reason: `${item.reason} · id ${item.id}` })));
}
