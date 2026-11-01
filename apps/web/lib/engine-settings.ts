import { LONG_WORK_MAX_MINUTES, LONG_WORK_MAX_USD, LONG_WORK_MIN_MINUTES, LONG_WORK_MIN_USD } from "@workspace/shared";

/**
 * Campo numérico da engrenagem ("Orçamento por tarefa longa"): aceita vírgula ou ponto, ignora "US$"/"min".
 * `null` = texto inválido ou fora da faixa (o campo volta ao valor salvo; nunca ajusta em silêncio).
 */
export function parseEngineNumber(text: string, min: number, max: number, { integer = false } = {}): number | null {
	const cleaned = text.replace(/US\$|min|\s/gi, "").replace(",", ".");
	if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
	const value = Number(cleaned);
	if (!Number.isFinite(value) || value < min || value > max) return null;
	return integer ? Math.round(value) : Math.round(value * 100) / 100;
}

export const parseBudgetUsd = (text: string) => parseEngineNumber(text, LONG_WORK_MIN_USD, LONG_WORK_MAX_USD);
export const parseBudgetMinutes = (text: string) => parseEngineNumber(text, LONG_WORK_MIN_MINUTES, LONG_WORK_MAX_MINUTES, { integer: true });

/** "0,50" para o campo (vírgula, duas casas). */
export const formatBudgetUsd = (usd: number) => usd.toFixed(2).replace(".", ",");

/**
 * Blur do campo de orçamento: salva o rascunho, a não ser que o Esc tenha cancelado (o blur disparado pelo próprio
 * Esc roda com o rascunho antigo do closure e salvaria o texto digitado) ou nada tenha mudado.
 */
export function budgetBlurAction(input: { draft: string; saved: string; cancelled: boolean }): "skip" | "commit" {
	if (input.cancelled) return "skip";
	return input.draft.trim() === input.saved ? "skip" : "commit";
}
