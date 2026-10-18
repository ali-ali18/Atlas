import type { OpenRouterModel } from "@workspace/shared";

export type CuratedModel = {
	id: string;
	label: string;
};

export const DEFAULT_OPENROUTER_MODEL =
	process.env.NEXT_PUBLIC_OPENROUTER_MODEL?.trim() ||
	"openai/gpt-4o-mini";

export const CURATED_OPENROUTER_MODELS: CuratedModel[] = [
	{ id: "openai/gpt-4o-mini", label: "GPT-4o mini" },
	{ id: "openai/gpt-4o", label: "GPT-4o" },
	{ id: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
	{ id: "google/gemini-2.0-flash-001", label: "Gemini 2.0 Flash" },
	{ id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
	{ id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
];

const MODEL_STORAGE_PREFIX = "atlas:model:";

export function getStoredAgentModel(agentId: string): string | null {
	if (typeof window === "undefined") return null;
	const value = sessionStorage.getItem(`${MODEL_STORAGE_PREFIX}${agentId}`);
	return value && value.trim().length > 0 ? value.trim() : null;
}

export function setStoredAgentModel(agentId: string, model: string): void {
	sessionStorage.setItem(`${MODEL_STORAGE_PREFIX}${agentId}`, model.trim());
}

export function resolveAgentModel(
	agentId: string,
	agentModel?: string,
): string {
	return (
		agentModel?.trim() ||
		getStoredAgentModel(agentId) ||
		DEFAULT_OPENROUTER_MODEL
	);
}

/** Nome legível de um provider a partir do slug (ex.: "openai" → "OpenAI"). */
export function providerLabel(provider: string): string {
	const overrides: Record<string, string> = {
		openai: "OpenAI",
		anthropic: "Anthropic",
		google: "Google",
		"meta-llama": "Meta",
		"x-ai": "xAI",
		xai: "xAI",
		mistralai: "Mistral",
		deepseek: "DeepSeek",
		qwen: "Qwen",
		cohere: "Cohere",
	};
	return (
		overrides[provider] ??
		provider
			.split("-")
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(" ")
	);
}

/** Agrupa modelos por provider (Record) com provedores e itens ordenados. */
export function groupModelsByProvider<T extends OpenRouterModel>(
	models: T[],
): Record<string, T[]> {
	const buckets: Record<string, T[]> = {};
	for (const model of models) {
		const vendor = "vendor" in model && typeof model.vendor === "string" ? model.vendor : model.provider;
		const bucket = buckets[vendor] ?? (buckets[vendor] = []);
		bucket.push(model);
	}

	const sorted: Record<string, T[]> = {};
	for (const provider of Object.keys(buckets).sort((a, b) =>
		a.localeCompare(b),
	)) {
		sorted[provider] = (buckets[provider] ?? []).sort((a, b) =>
			a.name.localeCompare(b.name),
		);
	}
	return sorted;
}
