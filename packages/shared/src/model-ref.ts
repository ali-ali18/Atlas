export type ModelProvider = "openrouter" | "chatgpt" | "anthropic" | "opencode-go";
export type ModelRef = { provider: ModelProvider; slug: string };

/** Prefixo do id interno por provedor direto (OpenRouter não tem prefixo: o id legado é o do vendor). */
export const DIRECT_PROVIDER_PREFIX = {
	chatgpt: "chatgpt/",
	anthropic: "anthropic-direct/",
	"opencode-go": "opencode-go/",
} as const;

function validateSlug(slug: string): void {
	if (!/^[A-Za-z0-9._:-]{1,256}$/.test(slug))
		throw new RangeError("Invalid model slug");
}

/** IDs legados continuam no OpenRouter, inclusive vendors desconhecidos. */
export function parseModelRef(id: string): ModelRef {
	if (!id || id.trim() !== id || id.length > 512)
		throw new RangeError("Invalid model reference");
	for (const provider of Object.keys(DIRECT_PROVIDER_PREFIX) as (keyof typeof DIRECT_PROVIDER_PREFIX)[]) {
		const prefix = DIRECT_PROVIDER_PREFIX[provider];
		if (!id.startsWith(prefix)) continue;
		const slug = id.slice(prefix.length);
		validateSlug(slug);
		return { provider, slug };
	}
	return { provider: "openrouter", slug: id };
}

export function formatModelRef(provider: ModelProvider, slug: string): string {
	if (provider !== "openrouter") {
		validateSlug(slug);
		return `${DIRECT_PROVIDER_PREFIX[provider]}${slug}`;
	}
	if (parseModelRef(slug).provider !== "openrouter")
		throw new RangeError("Invalid OpenRouter model reference");
	return slug;
}

/** Provedores que usam a chave do próprio usuário guardada no cofre (sem OpenRouter). */
export type ApiKeyProvider = "anthropic" | "opencode-go";
export const API_KEY_PROVIDERS: readonly ApiKeyProvider[] = ["anthropic", "opencode-go"];
export function isApiKeyProvider(value: unknown): value is ApiKeyProvider {
	return value === "anthropic" || value === "opencode-go";
}
export const API_KEY_PROVIDER_LABEL: Record<ApiKeyProvider, string> = {
	anthropic: "Anthropic",
	"opencode-go": "OpenCode Go",
};
