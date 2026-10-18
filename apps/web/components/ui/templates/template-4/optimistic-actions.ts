import type { Agent } from "./data";

/**
 * Ações otimistas da lista de bots (fixar, mover de sessão, trocar modelo, principal, notificar, lido):
 * a tela muda na hora; se o servidor recusar, volta ao que estava e avisa em português claro.
 */

export function pinFailureMessage(name: string, kind: "pin" | "unpin" | "reorder"): string {
	if (kind === "pin") return `Não deu para fixar o ${name}. Tente de novo.`;
	if (kind === "unpin") return `Não deu para desafixar o ${name}. Tente de novo.`;
	return `Não deu para reordenar o ${name}. Tente de novo.`;
}

export const sectionFailureMessage = (name: string) => `Não deu para mover o ${name} de sessão. Tente de novo.`;
export const modelFailureMessage = (name: string) => `Não deu para trocar o modelo do ${name}. Tente de novo.`;
export const primaryFailureMessage = (name: string, value: boolean) =>
	value ? `Não deu para definir o ${name} como principal. Tente de novo.` : `Não deu para tirar o ${name} de principal. Tente de novo.`;
export const notifyFailureMessage = (name: string) => `Não deu para salvar as notificações do ${name}. Tente de novo.`;
export const readFailureMessage = (name: string, unread: boolean) =>
	unread ? `Não deu para marcar a conversa do ${name} como não lida.` : `Não deu para marcar a conversa do ${name} como lida.`;
export const deleteBotFailureMessage = (name: string) => `Não deu para apagar o ${name}. Tente de novo.`;
export const sectionActionFailureMessage = (action: "create" | "rename" | "reorder" | "delete") =>
	({
		create: "Não deu para criar a sessão. Tente de novo.",
		rename: "Não deu para renomear a sessão. Tente de novo.",
		reorder: "Não deu para mudar a ordem das sessões. Tente de novo.",
		delete: "Não deu para apagar a sessão. Tente de novo.",
	})[action];

export function pinChangeKind(before: Pick<Agent, "pinned">, after: Pick<Agent, "pinned">): "pin" | "unpin" | "reorder" {
	if (!before.pinned && after.pinned) return "pin";
	if (before.pinned && !after.pinned) return "unpin";
	return "reorder";
}

/** Devolve ao agente `id` os campos de `snapshot` (o que ele tinha antes da mudança otimista). */
export function restoreAgentFields(agents: Agent[], id: string, snapshot: Partial<Agent>): Agent[] {
	return agents.map((agent) => (agent.id === id ? { ...agent, ...snapshot } : agent));
}

/**
 * Roda o pedido ao servidor de uma ação já aplicada na tela. Se falhar: desfaz (`revert`) e avisa (`notify`).
 * Resolve `true` se deu certo.
 */
export async function settleOptimistic(input: {
	request: Promise<unknown>;
	revert: () => void;
	message: string;
	notify: (message: string) => void;
	log?: (error: unknown) => void;
}): Promise<boolean> {
	try {
		await input.request;
		return true;
	} catch (error) {
		input.log?.(error);
		input.revert();
		input.notify(input.message);
		return false;
	}
}
