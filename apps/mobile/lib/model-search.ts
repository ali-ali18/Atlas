// Busca do seletor de modelo: uma lista só, de todas as fontes. Puro.
import type { ModelOption } from "./model-catalog";

/** Sem acentos, sem diferenciar maiúsculas e com pontuação virando espaço ("GPT-5.1" e "gpt 5 1" se encontram). */
export function normalizeSearch(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/**
 * Filtra por nome, id (modelo e provedor) e origem; todas as palavras digitadas têm de aparecer. Ordem: nome começando
 * com o que foi digitado, depois nome que contém, depois só id/origem; dentro de cada grupo, a ordem de entrada.
 */
export function searchModels(options: readonly ModelOption[], query: string): ModelOption[] {
	const normalized = normalizeSearch(query);
	if (!normalized) return [];
	const terms = normalized.split(" ");
	const ranked: Array<{ option: ModelOption; rank: number; index: number }> = [];
	options.forEach((option, index) => {
		const name = normalizeSearch(option.name);
		const haystack = `${name} ${normalizeSearch(option.id)} ${normalizeSearch(option.source ?? "")}`;
		if (!terms.every((term) => haystack.includes(term))) return;
		const rank = name.startsWith(normalized) ? 0 : terms.every((term) => name.includes(term)) ? 1 : 2;
		ranked.push({ option, rank, index });
	});
	return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).map((entry) => entry.option);
}
