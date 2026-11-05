import { parseModelRef, type ModelProvider } from "@workspace/shared";

/**
 * Modelos do `matrix` por prefixo:
 *   anthropic/<modelo>      → Anthropic direto (id interno `anthropic-direct/<modelo>`)
 *   opencode-go/<modelo>    → OpenCode Go (protocolo por `goProtocolFor`)
 *   openrouter/<id> ou id   → OpenRouter (comportamento anterior; `openrouter/anthropic/x` é o Claude via OpenRouter)
 * A chave vem do ambiente e só é checada aqui; o valor nunca entra em mensagem, log nem relatório.
 */

export type MatrixProvider = "anthropic" | "opencode-go" | "openrouter";

export type ResolvedModel = {
	/** Como o usuário escreveu (rótulo do relatório). */
	spec: string;
	provider: MatrixProvider;
	slug: string;
	/** Id que o runtime e o roteador de provedores entendem (`parseModelRef`). */
	internalId: string;
	/** Chave na tabela de preços. */
	priceKey: string;
};

/** Variáveis de ambiente com a chave de cada provedor, na ordem de preferência. */
export const KEY_ENV: Record<MatrixProvider, readonly string[]> = {
	anthropic: ["CLAUDE_KEY", "ANTHROPIC_API_KEY"],
	"opencode-go": ["OPENCODE_GO_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
};

const SLUG = /^[A-Za-z0-9._:-]{1,256}$/;

export function resolveModelSpec(spec: string): ResolvedModel {
	const text = spec.trim();
	if (!text) throw new Error("modelo vazio em --models");
	const direct = (provider: "anthropic" | "opencode-go", prefix: string, internalPrefix: string): ResolvedModel => {
		const slug = text.slice(prefix.length);
		if (!SLUG.test(slug)) throw new Error(`modelo inválido: ${text}`);
		return { spec: text, provider, slug, internalId: `${internalPrefix}${slug}`, priceKey: `${provider}/${slug}` };
	};
	if (text.startsWith("anthropic/")) return direct("anthropic", "anthropic/", "anthropic-direct/");
	if (text.startsWith("opencode-go/")) return direct("opencode-go", "opencode-go/", "opencode-go/");
	const slug = text.startsWith("openrouter/") ? text.slice("openrouter/".length) : text;
	if (!slug) throw new Error(`modelo inválido: ${text}`);
	// Prefixos internos de outros provedores não passam por aqui: usar anthropic/ e opencode-go/.
	const ref = parseModelRef(slug);
	if (ref.provider !== ("openrouter" satisfies ModelProvider)) throw new Error(`modelo ${text}: use o prefixo anthropic/ ou opencode-go/ (ids internos como "${slug.split("/")[0]}/" não são aceitos)`);
	return { spec: text, provider: "openrouter", slug, internalId: slug, priceKey: `openrouter/${slug}` };
}

export const resolveModelSpecs = (specs: readonly string[]): ResolvedModel[] => specs.map(resolveModelSpec);

/** Primeira variável da lista que tem valor. */
export function readProviderKey(provider: MatrixProvider, env: Record<string, string | undefined>): { value: string; envName: string } | null {
	for (const envName of KEY_ENV[provider]) {
		const value = env[envName]?.trim();
		if (value) return { value, envName };
	}
	return null;
}

/** Falha ANTES de qualquer execução se faltar a chave de algum provedor usado. A mensagem cita só o nome da variável. */
export function assertProviderKeys(models: readonly ResolvedModel[], env: Record<string, string | undefined>): void {
	const missing = new Map<MatrixProvider, string>();
	for (const model of models) if (!missing.has(model.provider) && !readProviderKey(model.provider, env)) missing.set(model.provider, model.spec);
	if (missing.size === 0) return;
	const lines = [...missing].map(([provider, spec]) => `${provider} (${spec}): defina ${KEY_ENV[provider].join(" ou ")}`);
	throw new Error(`chave ausente — ${lines.join("; ")}. Nada foi executado (use --env-file <.env> ou exporte a variável).`);
}

/** Valores das chaves dos provedores usados, para o `redactSecrets` na hora de gravar. */
export function providerSecrets(models: readonly ResolvedModel[], env: Record<string, string | undefined>): string[] {
	const out = new Set<string>();
	for (const provider of new Set(models.map((model) => model.provider))) {
		for (const name of KEY_ENV[provider]) if (env[name]?.trim()) out.add(env[name]!.trim());
	}
	return [...out];
}
