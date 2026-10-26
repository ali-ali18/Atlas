import type { RoutineNotifyMode } from "@workspace/shared";

/**
 * Entrega do brief "Seu dia". O run nasce SEM conversa (ver `runsDetachedFromChat`), então o fim do run não
 * grava a resposta nem manda o push sozinho: este módulo faz as duas coisas, na conversa do bot do dono.
 *
 * - Push: sai assim que o brief fica pronto (com a frase curta), se a rotina avisa "sempre".
 * - Mensagem no chat: só entra se NENHUMA tarefa está rodando na conversa. Com tarefa em andamento a linha não
 *   é gravada (não atropela a resposta que está sendo escrita); o painel já está na Biblioteca e o push avisou.
 */

export type BriefDeliveryDeps = {
	/** Conversa do bot, escopada pelo dono (null = bot sem conversa). */
	conversationOf: (botId: string, userId: string) => Promise<string | null>;
	hasActiveRun: (conversationId: string) => Promise<boolean>;
	appendMessage: (conversationId: string, text: string) => Promise<unknown>;
	/** Ausente = sem chaves de push. */
	push?: (userId: string, conversationId: string, text: string) => Promise<unknown>;
};

export type BriefDeliveryResult = { posted: boolean; pushed: boolean; reason?: string };

/**
 * Run de rotina sem conversa = brief "Seu dia" (só o brief nasce assim, ver `runsDetachedFromChat`): só leitura e
 * entregue por aqui. Decidido pelo próprio run, sem consultar o banco: uma falha transitória na consulta do modelo
 * da rotina não pode abrir as ferramentas de escrita (falha fechada).
 */
export function isDetachedBriefRun(run: { origin?: string | null; conversationId?: string | null }): boolean {
	return run.origin === "routine" && !run.conversationId;
}

export async function deliverDailyBrief(
	input: { userId: string; botId: string | null | undefined; text: string; notify: RoutineNotifyMode },
	deps: BriefDeliveryDeps,
): Promise<BriefDeliveryResult> {
	const text = input.text.trim();
	if (!text) return { posted: false, pushed: false, reason: "sem texto" };
	if (!input.botId) return { posted: false, pushed: false, reason: "sem bot" };
	const conversationId = await deps.conversationOf(input.botId, input.userId);
	if (!conversationId) return { posted: false, pushed: false, reason: "bot sem conversa" };
	let pushed = false;
	if (input.notify === "always" && deps.push) {
		try {
			await deps.push(input.userId, conversationId, text);
			pushed = true;
		} catch (error) {
			console.error("[brief] push não enviado", error instanceof Error ? error.message : "erro");
		}
	}
	if (await deps.hasActiveRun(conversationId)) return { posted: false, pushed, reason: "tarefa em andamento na conversa" };
	await deps.appendMessage(conversationId, text);
	return { posted: true, pushed };
}
