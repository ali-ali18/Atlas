import type { ProviderModel } from "./model.js";

export type RecommendedModel = { id: string; label: string; note: string };
/** Sugestões só aparecem quando a conta/provedor devolver a referência no catálogo. */
export const RECOMMENDED_MODELS: readonly RecommendedModel[] = [
	{ id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek Flash", note: "Opção econômica para tarefas gerais" },
	{ id: "openai/gpt-4o-mini", label: "GPT-4o mini", note: "Modelo compacto com suporte a imagens" },
	{ id: "chatgpt/luna", label: "Luna", note: "Usa a cota do plano ChatGPT" },
];

export function recommendedModels(models: readonly ProviderModel[]): ProviderModel[] {
	const byId = new Map(models.map((model) => [model.id, model]));
	return RECOMMENDED_MODELS.flatMap((entry) => {
		const model = byId.get(entry.id);
		return model ? [model] : [];
	});
}
