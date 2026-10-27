import type { NotifyResult } from "@workspace/db";

export const VM_STOPPED_PUSH_TEXT = "Desliguei o computador para liberar memória. Ele liga de novo quando eu precisar.";
export const VM_STOPPED_CHAT_TEXT = "Desliguei o computador para liberar memória; ele liga de novo quando eu precisar.";

type GuardVm = { userId: string; conversationId?: string };

export type VmGuardDeps = {
	/** Push (null quando o servidor não tem VAPID/Redis). */
	push: ((userId: string, conversationId: string, text: string) => Promise<NotifyResult>) | null;
	/** A conversa é do usuário (e de um bot dele)? Escopo por dono. */
	ownsConversation: (userId: string, conversationId: string) => Promise<boolean>;
	/** O dono tem run usando ou esperando esta VM? */
	holdsVm: (userId: string, conversationId: string) => Promise<boolean>;
	/** Grava a mensagem do bot na conversa. */
	appendMessage: (conversationId: string, text: string) => Promise<unknown>;
};

/**
 * VM que o guarda de memória não pode parar: sem dono verificável (sem usuário/conversa, ou conversa que
 * não é dele), ou com run em uso/esperando o usuário. Sem como avisar o dono, não desliga.
 */
export async function isVmProtectedFromGuard(vm: GuardVm, deps: Pick<VmGuardDeps, "ownsConversation" | "holdsVm">): Promise<boolean> {
	if (!vm.userId || !vm.conversationId) return true;
	if (!(await deps.ownsConversation(vm.userId, vm.conversationId))) return true;
	return deps.holdsVm(vm.userId, vm.conversationId);
}

/**
 * Avisa o dono DEPOIS de a VM ter sido desligada: a mensagem na conversa (passado, canal garantido) e o push
 * como bônus de melhor esforço. Só a falha da mensagem lança (quem chama apenas registra).
 */
export async function noticeVmStopped(vm: GuardVm, deps: Pick<VmGuardDeps, "push" | "appendMessage">): Promise<void> {
	if (!vm.userId || !vm.conversationId) return;
	await deps.appendMessage(vm.conversationId, VM_STOPPED_CHAT_TEXT);
	await deps.push?.(vm.userId, vm.conversationId, VM_STOPPED_PUSH_TEXT).catch(() => undefined);
}
