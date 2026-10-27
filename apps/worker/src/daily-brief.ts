import {
	appendConversationMessage,
	claimBriefPosting,
	getBotConversationId,
	listActiveRunsForConversation,
	listPendingBriefs,
	markBriefPending,
	releaseBriefPosting,
	type Notify,
} from "@workspace/db";
import type { RoutineNotifyMode } from "@workspace/shared";

/**
 * Entrega do brief "Seu dia". O run nasce SEM conversa (ver `runsDetachedFromChat`), então o fim do run não
 * grava a resposta nem manda o push sozinho: este módulo faz as duas coisas, na conversa do bot do dono.
 *
 * - A resposta final do run É o brief: vira uma mensagem do assistente na conversa do bot.
 * - Push: sai assim que o brief fica pronto (primeira linha como corpo), se a rotina avisa "sempre".
 * - Conversa livre: a mensagem entra na hora. Tarefa rodando na conversa: o brief fica PENDENTE (guardado no
 *   `RoutineRun`) e entra logo depois que a tarefa termina (`flushPendingBriefs`, chamado no fim de run e na
 *   varredura de 60 s, que também cobre queda do worker no meio). A virada pendente -> postado é atômica
 *   (`claim`), então o brief nunca entra duas vezes.
 */

export type PendingBriefItem = { routineRunId: string; userId: string; botId: string; text: string };

export type BriefDeliveryDeps = {
	/** Conversa do bot, escopada pelo dono (null = bot sem conversa). */
	conversationOf: (botId: string, userId: string) => Promise<string | null>;
	hasActiveRun: (conversationId: string) => Promise<boolean>;
	appendMessage: (conversationId: string, text: string) => Promise<unknown>;
	/** Ausente = sem chaves de push. */
	push?: (userId: string, conversationId: string, text: string) => Promise<unknown>;
	/** Guarda o brief como pendente no run da rotina. */
	markPending: (routineRunId: string, text: string) => Promise<unknown>;
	/** Reivindica a postagem; só um chamador por brief recebe true. */
	claim: (routineRunId: string, text: string) => Promise<boolean>;
	/** Devolve o brief a pendente quando a gravação da mensagem falhou. */
	release: (routineRunId: string, text: string) => Promise<unknown>;
};

export type BriefDeliveryResult = { posted: boolean; pushed: boolean; reason?: string };

/** Primeira linha não vazia do brief: o corpo do push. */
export function briefPushBody(text: string): string {
	const first = text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? text.trim();
	return first.length > 180 ? `${first.slice(0, 179)}…` : first;
}

async function postPending(item: PendingBriefItem, conversationId: string, deps: BriefDeliveryDeps): Promise<boolean> {
	if (!(await deps.claim(item.routineRunId, item.text))) return false;
	try {
		await deps.appendMessage(conversationId, item.text);
		return true;
	} catch (error) {
		await deps.release(item.routineRunId, item.text).catch(() => undefined);
		console.error("[brief] mensagem não gravada; volta a pendente", error instanceof Error ? error.message : "erro");
		return false;
	}
}

/**
 * Run de rotina sem conversa = brief "Seu dia" (só o brief nasce assim, ver `runsDetachedFromChat`): só leitura e
 * entregue por aqui. Decidido pelo próprio run, sem consultar o banco: uma falha transitória na consulta do modelo
 * da rotina não pode abrir as ferramentas de escrita (falha fechada).
 */
export function isDetachedBriefRun(run: { origin?: string | null; conversationId?: string | null }): boolean {
	return run.origin === "routine" && !run.conversationId;
}

export async function deliverDailyBrief(
	input: { routineRunId: string | null | undefined; userId: string; botId: string | null | undefined; text: string; notify: RoutineNotifyMode },
	deps: BriefDeliveryDeps,
): Promise<BriefDeliveryResult> {
	const text = input.text.trim();
	if (!text) return { posted: false, pushed: false, reason: "sem texto" };
	if (!input.botId) return { posted: false, pushed: false, reason: "sem bot" };
	if (!input.routineRunId) return { posted: false, pushed: false, reason: "sem execução da rotina" };
	const conversationId = await deps.conversationOf(input.botId, input.userId);
	if (!conversationId) return { posted: false, pushed: false, reason: "bot sem conversa" };
	// Pendente primeiro: se o worker cair daqui em diante, a varredura ainda entrega.
	await deps.markPending(input.routineRunId, text);
	let pushed = false;
	if (input.notify === "always" && deps.push) {
		try {
			await deps.push(input.userId, conversationId, briefPushBody(text));
			pushed = true;
		} catch (error) {
			console.error("[brief] push não enviado", error instanceof Error ? error.message : "erro");
		}
	}
	if (await deps.hasActiveRun(conversationId)) return { posted: false, pushed, reason: "tarefa em andamento na conversa; entra quando terminar" };
	const posted = await postPending({ routineRunId: input.routineRunId, userId: input.userId, botId: input.botId, text }, conversationId, deps);
	return { posted, pushed };
}

/**
 * Posta os briefs pendentes cuja conversa já está livre. Chamado quando um run termina e a cada 60 s.
 * Nunca lança; devolve quantos entraram.
 */
export async function flushPendingBriefs(
	deps: BriefDeliveryDeps & { listPending: () => Promise<PendingBriefItem[]> },
): Promise<number> {
	let posted = 0;
	try {
		for (const item of await deps.listPending()) {
			try {
				const conversationId = await deps.conversationOf(item.botId, item.userId);
				if (!conversationId) continue;
				if (await deps.hasActiveRun(conversationId)) continue;
				if (await postPending(item, conversationId, deps)) posted += 1;
			} catch (error) {
				console.error("[brief] varredura falhou para um brief", error instanceof Error ? error.message : "erro");
			}
		}
	} catch (error) {
		console.error("[brief] varredura falhou", error instanceof Error ? error.message : "erro");
	}
	return posted;
}

/** Dependências reais (banco) da entrega; `notify` ausente = sem chaves de push. */
export function briefDeliveryDeps(
	notify?: Notify,
): BriefDeliveryDeps & { listPending: () => Promise<PendingBriefItem[]> } {
	return {
		conversationOf: getBotConversationId,
		hasActiveRun: async (conversationId) => (await listActiveRunsForConversation(conversationId)).length > 0,
		appendMessage: (conversationId, text) => appendConversationMessage(conversationId, "assistant", text, "routine"),
		push: notify ? (userId, conversationId, text) => notify(userId, conversationId, "reminder", text) : undefined,
		markPending: markBriefPending,
		claim: claimBriefPosting,
		release: releaseBriefPosting,
		listPending: () => listPendingBriefs(),
	};
}
