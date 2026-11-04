// Memória (só do processo, nunca disco) do que os cartões de pedido precisam lembrar enquanto o app está aberto: a linha
// da lista desmonta ao rolar, e o estado do `useState` iria junto. Fica por id do cartão, fora da linha.
// Aqui NUNCA entra valor de segredo, senha nem código: só o passo e as respostas do questionário (escolhas e texto da
// própria pergunta) e a marca "este segredo já foi guardado no Cofre".
import type { StepState } from "./questionnaire";

const drafts = new Map<string, StepState>();
const stored = new Set<string>();
/** Teto para a memória não crescer sem fim numa sessão longa. */
const MAX = 50;

function cap<T>(map: Map<string, T>): void {
	while (map.size > MAX) map.delete(map.keys().next().value as string);
}

export function getQuestionnaireDraft(questionnaireId: string): StepState | undefined {
	return drafts.get(questionnaireId);
}

export function setQuestionnaireDraft(questionnaireId: string, state: StepState): void {
	drafts.set(questionnaireId, state);
	cap(drafts);
}

export function clearQuestionnaireDraft(questionnaireId: string): void {
	drafts.delete(questionnaireId);
}

/** O Cofre já guardou os valores deste pedido (só o aviso ao bot falhou): não pede os valores de novo. */
export function markSecretsStored(confirmId: string): void {
	stored.add(confirmId);
	while (stored.size > MAX) stored.delete(stored.values().next().value as string);
}

export function isSecretsStored(confirmId: string): boolean {
	return stored.has(confirmId);
}

export function clearRequestMemory(): void {
	drafts.clear();
	stored.clear();
}
