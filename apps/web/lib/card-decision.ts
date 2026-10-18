import { isCardConfirmToken } from "@workspace/shared";
import type { Message } from "@/components/ui/templates/template-4/data";

/**
 * Texto que os botões dos cartões enviam (confirmar / cancelar). É um contrato UI -> API:
 * quem o resolve é o servidor (intenção pendente), nunca o run em andamento.
 */
export function isCardProtocolText(text: string): boolean {
	return isCardConfirmToken(text) || /^cancela isso$/i.test(text.trim());
}

/**
 * Cartão decidido em andamento. Vive no módulo (não no componente): remontar a lista,
 * trocar de aba ou reidratar o histórico não pode liberar um segundo envio da mesma decisão.
 */
const deciding = new Set<string>();

export function cardDecisionKey(conversationId: string | undefined, card: { id: string; confirmId?: string }): string {
	return `${conversationId ?? ""}|${card.confirmId ?? card.id}`;
}

/** `true` = esta é a primeira decisão do cartão e pode enviar; `false` = já há uma a caminho. */
export function beginCardDecision(key: string): boolean {
	if (deciding.has(key)) return false;
	deciding.add(key);
	return true;
}

export function endCardDecision(key: string): void {
	deciding.delete(key);
}

/** Só testes. */
export function resetCardDecisions(): void {
	deciding.clear();
}

/**
 * Há uma aprovação de código esperando o usuário? Só o cartão mais recente conta: o servidor guarda
 * uma única intenção pendente por conversa, então um cartão antigo ainda "pendente" (aprovação que
 * não chegou a gravar) nunca é a que o run espera e não pode manter "Aguardando sua aprovação".
 */
export function hasActionableDevApproval(messages: Message[]): boolean {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]!;
		if (message.kind === "confirm" && message.devApproval) return (message.status ?? "pending") === "pending";
	}
	return false;
}
