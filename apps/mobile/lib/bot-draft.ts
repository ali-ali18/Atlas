// Rascunho do "Editar Bot", compartilhado com a tela de Avatar (que o altera e volta). Módulo leve com assinatura:
// o rascunho vive só enquanto a edição está aberta e nada vai ao servidor até o "Concluído" do Editar Bot.
import * as React from "react";
import type { BotDraft } from "./bot-edit";

const drafts = new Map<string, BotDraft>();
const listeners = new Set<() => void>();
const notify = () => {
	for (const listener of listeners) listener();
};

export function initDraft(botId: string, draft: BotDraft): void {
	drafts.set(botId, draft);
	notify();
}

export function updateDraft(botId: string, patch: Partial<BotDraft>): void {
	const current = drafts.get(botId);
	if (!current) return;
	drafts.set(botId, { ...current, ...patch });
	notify();
}

export function clearDraft(botId: string): void {
	if (drafts.delete(botId)) notify();
}

export const getDraft = (botId: string): BotDraft | null => drafts.get(botId) ?? null;

export function useDraft(botId: string): BotDraft | null {
	return React.useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		() => getDraft(botId),
	);
}
