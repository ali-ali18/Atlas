import type { OpenRouterModel, ProviderModel } from "@workspace/shared";
import { recommendedModels } from "@workspace/shared";

/** Provedor pelo prefixo do id (chatgpt/, anthropic-direct/, opencode-go/); o resto é OpenRouter. */
export function pickerProviderOf(id: string): ProviderModel["provider"] {
	if (id.startsWith("chatgpt/")) return "chatgpt";
	if (id.startsWith("anthropic-direct/")) return "anthropic";
	if (id.startsWith("opencode-go/")) return "opencode-go";
	return "openrouter";
}
/** Nome do grupo no seletor, por provedor de chave própria. */
export const KEY_GROUP_LABEL = { anthropic: "Anthropic", "opencode-go": "OpenCode Go" } as const;
/** "via OpenCode Go" / "via Anthropic" para modelos de chave própria; vazio nos demais (o vendor já é o nome). */
export function pickerViaLabel(id: string): string | null {
	const provider = pickerProviderOf(id);
	return provider === "anthropic" || provider === "opencode-go" ? `via ${KEY_GROUP_LABEL[provider]}` : null;
}
/** Ícone (marca) do provedor no seletor. */
export function pickerLogoOf(model: Pick<ProviderModel, "id" | "provider" | "vendor">): string {
	if (model.provider === "chatgpt") return "openai";
	if (model.provider === "anthropic") return "anthropic";
	if (model.provider === "opencode-go") return "opencode";
	return model.vendor ?? model.id.split("/")[0] ?? "openrouter";
}
export function normalizePickerModels(models: readonly (OpenRouterModel | ProviderModel)[]): ProviderModel[] {
	return models.map((model) => {
		const provider = pickerProviderOf(model.id);
		return {
			...model, provider,
			...(provider === "openrouter" ? { vendor: "vendor" in model ? model.vendor : model.provider === "openrouter" ? model.id.split("/")[0] : model.provider } : {}),
			capabilities: "capabilities" in model ? model.capabilities : "unknown",
		};
	});
}
export function searchPickerModels(models: readonly ProviderModel[], query: string): ProviderModel[] {
	const parts = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return models.filter((model) => parts.every((part) => `${model.name} ${model.id} ${model.provider} ${model.vendor ?? ""}`.toLowerCase().includes(part)));
}
export function pickerRecommendations(models: readonly ProviderModel[]): ProviderModel[] {
	return recommendedModels(models.filter((model) => model.provider === "openrouter"));
}
export function canUseLegacyChat(model: string, status: number, attachmentCount: number): boolean {
	return status === 503 && attachmentCount === 0 && !model.startsWith("chatgpt/");
}
