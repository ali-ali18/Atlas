import type { NotifyResult } from "@workspace/db";

export const VM_STOPPED_PUSH_TEXT = "Desliguei o computador para liberar memória. Ele liga de novo quando eu precisar.";
export const VM_STOPPED_CHAT_TEXT = "Desliguei o computador para liberar memória; ele liga de novo quando eu precisar.";

export type VmStopNoticeDeps = {
	/** Push (null quando o servidor não tem VAPID/Redis). */
	push: ((userId: string, conversationId: string, text: string) => Promise<NotifyResult>) | null;
	/** A conversa é do usuário (e de um bot dele)? Escopo por dono. */
	ownsConversation: (userId: string, conversationId: string) => Promise<boolean>;
	/** Grava a mensagem do bot na conversa. */
	appendMessage: (conversationId: string, text: string) => Promise<unknown>;
};

/**
 * Avisa o dono ANTES de a VM ser desligada pelo guarda de memória. O push pode não sair (sem VAPID, aviso
 * desligado, conversa aberta...), então a mensagem na conversa é o aviso garantido. Se o push não saiu E a
 * mensagem não foi gravada, lança: o guarda adia a parada para a próxima rodada.
 */
export async function noticeVmStop(vm: { userId: string; conversationId?: string }, deps: VmStopNoticeDeps): Promise<void> {
	if (!vm.userId || !vm.conversationId) return;
	if (!(await deps.ownsConversation(vm.userId, vm.conversationId))) return;
	const pushed = await (deps.push?.(vm.userId, vm.conversationId, VM_STOPPED_PUSH_TEXT) ?? Promise.resolve<NotifyResult>({ status: "skipped", reason: "error" })).catch((): NotifyResult => ({ status: "skipped", reason: "error" }));
	try {
		await deps.appendMessage(vm.conversationId, VM_STOPPED_CHAT_TEXT);
	} catch (error) {
		if (pushed.status !== "sent") throw new Error(`could not warn the owner (push ${pushed.status === "skipped" ? pushed.reason : "sent"}, message: ${error instanceof Error ? error.message : "error"})`);
	}
}
