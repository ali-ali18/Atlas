// A pílula do composer ("Opus 5.5 Médio"): nome curto do modelo atual e, em cinza, o esforço. Tudo puro.
import { effortForModel, REASONING_EFFORT_LABELS } from "@workspace/shared";
import { findOption, unlistedOption, type ModelCatalog } from "./model-catalog";
import { currentSelection, type ModelChoice } from "./model-choice";

export const PILL_NAME_MAX = 18;

/**
 * Nome curto para caber na pílula: sem o "Claude " do começo ("Claude Opus 5.5" -> "Opus 5.5"), nomes que já são curtos
 * ficam como estão ("GPT-5.1") e os longos são cortados em `max` caracteres com reticências.
 */
export function shortModelName(name: string, max = PILL_NAME_MAX): string {
	const trimmed = name.trim().replace(/^claude\s+/i, "");
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

export type ModelPill = { name: string; /** "Desligado", "Baixo", "Médio" ou "Alto"; `null` = nada (sem raciocínio ou "Padrão do modelo"). */ effort: string | null };

/** O que a pílula mostra: Automático, o modelo atual (escolha salva ou o do bot) com o esforço, ou "Modelo" enquanto não se sabe. */
export function modelPill(choice: ModelChoice | null, catalog: ModelCatalog | null): ModelPill {
	const selection = currentSelection(choice, catalog?.bot ?? null);
	if (selection.mode === "auto") return { name: "Automático", effort: null };
	if (selection.mode === "unknown") return { name: "Modelo", effort: null };
	const option = findOption(catalog, selection.model) ?? unlistedOption(selection.model);
	const effort = option.efforts.length > 0 ? effortForModel(selection.effort, option.id, option.info) : undefined;
	return { name: shortModelName(option.name), effort: effort ? REASONING_EFFORT_LABELS[effort] : null };
}

/** Rótulo para leitor de tela: "Modelo: Opus 5.5, esforço Médio. Trocar modelo". */
export function pillAccessibilityLabel(pill: ModelPill): string {
	return `Modelo: ${pill.name}${pill.effort ? `, esforço ${pill.effort}` : ""}. Trocar modelo`;
}
