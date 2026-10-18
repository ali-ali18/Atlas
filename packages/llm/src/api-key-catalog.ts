import { createHash } from "node:crypto";
import type { ApiKeyProvider, ProviderModel } from "@workspace/shared";
import { fetchAnthropicModels, fetchOpencodeGoModels, type ApiKeyCatalog } from "./api-key-models.js";
import { createModelCatalogCache } from "./model-catalog-cache.js";
import type { GoProtocol } from "./opencode/routing.js";

type Entry = { keyHash: string; cache: ReturnType<typeof createModelCatalogCache<ApiKeyCatalog>> };

/**
 * Catálogo por usuário e provedor (Anthropic, OpenCode Go), com a chave do próprio
 * usuário. Cache por processo; trocar a chave descarta o cache. Sem chave = vazio.
 */
export function createApiKeyModelCatalog(deps: {
	getKey(userId: string, provider: ApiKeyProvider): Promise<string | null>;
	fetch?: typeof fetch;
	now?: () => number;
	ttlMs?: number;
}) {
	const entries = new Map<string, Entry>();
	const hash = (key: string) => createHash("sha256").update(key).digest("hex");

	async function load(userId: string, provider: ApiKeyProvider): Promise<{ connected: boolean; catalog: ApiKeyCatalog | null }> {
		const key = await deps.getKey(userId, provider);
		const id = `${userId}:${provider}`;
		if (!key) {
			entries.delete(id);
			return { connected: false, catalog: { models: [], protocols: {} } };
		}
		let entry = entries.get(id);
		if (!entry || entry.keyHash !== hash(key)) {
			const fetcher = provider === "anthropic" ? fetchAnthropicModels : fetchOpencodeGoModels;
			entry = {
				keyHash: hash(key),
				cache: createModelCatalogCache(
					async () => {
						const result = await fetcher(key, { fetch: deps.fetch });
						return Array.isArray(result) ? { models: result, protocols: {} } : result;
					},
					{ now: deps.now, ttlMs: deps.ttlMs ?? 600_000 },
				),
			};
			entries.set(id, entry);
		}
		return { connected: true, catalog: await entry.cache.get() };
	}

	return {
		async list(userId: string, provider: ApiKeyProvider): Promise<{ models: ProviderModel[]; connected: boolean; catalogAvailable: boolean }> {
			const { connected, catalog } = await load(userId, provider);
			return { models: catalog?.models ?? [], connected, catalogAvailable: catalog !== null };
		},
		/** `null` = catálogo indisponível (não bloqueia a execução). */
		async isKnown(userId: string, provider: ApiKeyProvider, id: string): Promise<boolean | null> {
			const { connected, catalog } = await load(userId, provider);
			if (!connected) return false;
			return catalog ? catalog.models.some((model) => model.id === id) : null;
		},
		async find(userId: string, provider: ApiKeyProvider, id: string): Promise<ProviderModel | undefined> {
			return (await load(userId, provider)).catalog?.models.find((model) => model.id === id);
		},
		/** Protocolo declarado pelo catálogo do Go para o slug, quando conhecido. */
		async protocolOf(userId: string, slug: string): Promise<GoProtocol | undefined> {
			return (await load(userId, "opencode-go").catch(() => ({ catalog: null }))).catalog?.protocols[slug];
		},
		clear(userId: string, provider: ApiKeyProvider) {
			entries.delete(`${userId}:${provider}`);
		},
	};
}
export type ApiKeyModelCatalog = ReturnType<typeof createApiKeyModelCatalog>;
