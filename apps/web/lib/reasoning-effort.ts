import {
	availableReasoningEfforts,
	effortForModel,
	parseReasoningEffort,
	type ModelCatalogInfo,
	type ReasoningEffort,
} from "@workspace/shared";
import type { Translator } from "./i18n/translator";

const STORAGE_PREFIX = "atlas:reasoning:";

/**
 * Nível de raciocínio escolhido na conversa do bot (localStorage: vale entre abas e recarregamentos, só neste navegador).
 * Storage indisponível (janela privada, dados bloqueados) = sem escolha: o chat segue o padrão do bot.
 */
export function getStoredReasoningEffort(agentId: string): ReasoningEffort | undefined {
	try {
		if (typeof window === "undefined") return undefined;
		return parseReasoningEffort(window.localStorage.getItem(`${STORAGE_PREFIX}${agentId}`));
	} catch {
		return undefined;
	}
}

/** `undefined` = "Padrão do modelo" (apaga a escolha). */
export function setStoredReasoningEffort(agentId: string, effort: ReasoningEffort | undefined): void {
	try {
		if (typeof window === "undefined") return;
		const key = `${STORAGE_PREFIX}${agentId}`;
		if (effort) window.localStorage.setItem(key, effort);
		else window.localStorage.removeItem(key);
	} catch {
		// Sem storage a escolha vale só nesta sessão da tela.
	}
}

/** Níveis que o seletor oferece para o modelo escolhido (vazio = sem controle: Automático, sem suporte ou outro provedor). */
export function reasoningChoicesFor(modelId: string, catalog?: ModelCatalogInfo): ReasoningEffort[] {
	return modelId ? availableReasoningEfforts(modelId, catalog) : [];
}

/**
 * O que a tela mostra como selecionado: o mesmo que o servidor vai usar naquele modelo
 * ("Desligado" vira "Baixo" onde o modelo não desliga). `undefined` = Padrão do modelo.
 */
export function shownReasoningEffort(effort: ReasoningEffort | undefined, modelId: string, catalog?: ModelCatalogInfo): ReasoningEffort | undefined {
	return modelId ? effortForModel(effort, modelId, catalog) : undefined;
}

export const reasoningEffortLabel = (effort: ReasoningEffort, { t }: Translator) => t(`reasoning.${effort}`);
