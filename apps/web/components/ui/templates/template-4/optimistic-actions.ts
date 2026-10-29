import { getActiveTranslator } from "@/lib/i18n/active";
import type { Translator } from "@/lib/i18n/translator";
import type { Agent } from "./data";

/**
 * Ações otimistas da lista de bots (fixar, mover de sessão, trocar modelo, principal, notificar, lido):
 * a tela muda na hora; se o servidor recusar, volta ao que estava e avisa em português claro.
 */

export function pinFailureMessage(name: string, kind: "pin" | "unpin" | "reorder", { t }: Translator = getActiveTranslator()): string {
	if (kind === "pin") return t("botActions.pinFailed", { name });
	if (kind === "unpin") return t("botActions.unpinFailed", { name });
	return t("botActions.reorderFailed", { name });
}

export const sectionFailureMessage = (name: string, { t }: Translator = getActiveTranslator()) => t("botActions.sectionMoveFailed", { name });
export const modelFailureMessage = (name: string, { t }: Translator = getActiveTranslator()) => t("botActions.modelFailed", { name });
export const primaryFailureMessage = (name: string, value: boolean, { t }: Translator = getActiveTranslator()) =>
	t(value ? "botActions.primarySetFailed" : "botActions.primaryUnsetFailed", { name });
export const notifyFailureMessage = (name: string, { t }: Translator = getActiveTranslator()) => t("botActions.notifyFailed", { name });
export const readFailureMessage = (name: string, unread: boolean, { t }: Translator = getActiveTranslator()) =>
	t(unread ? "botActions.markUnreadFailed" : "botActions.markReadFailed", { name });
export const deleteBotFailureMessage = (name: string, { t }: Translator = getActiveTranslator()) => t("botActions.deleteFailed", { name });
export const sectionActionFailureMessage = (action: "create" | "rename" | "reorder" | "delete", { t }: Translator = getActiveTranslator()) =>
	({
		create: t("botActions.section.createFailed"),
		rename: t("botActions.section.renameFailed"),
		reorder: t("botActions.section.reorderFailed"),
		delete: t("botActions.section.deleteFailed"),
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
