import type { Message } from "@/components/ui/templates/template-4/data";

/** Rascunho revisado pelo portão de qualidade: fica salvo, mas não aparece na conversa (pedido do dono). */
export function isRevisedDraftMessage(message: Message): boolean {
	return message.kind === "assistant" && Boolean(message.revised);
}
