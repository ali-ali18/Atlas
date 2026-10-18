import { createModelCatalogCache } from "@workspace/llm";
import { getModelCapabilities, parseOpenRouterModelInfo, type ModelCatalogInfo } from "@workspace/shared";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
async function loadModels(fetchModels: typeof fetch = fetch): Promise<{ ids: Set<string>; contexts: Map<string, number>; info: Map<string, ModelCatalogInfo> }> {
	const response = await fetchModels(OPENROUTER_MODELS_URL, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`OpenRouter responded ${response.status}`);
	const json = (await response.json()) as { data?: unknown[] };
	const ids = new Set<string>();
	const contexts = new Map<string, number>();
	const info = new Map<string, ModelCatalogInfo>();
	for (const item of Array.isArray(json.data) ? json.data : []) {
		const rawId = (item as { id?: unknown } | null)?.id;
		if (typeof rawId !== "string" || !rawId.trim()) continue;
		const id = rawId.trim();
		ids.add(id);
		const parsed = parseOpenRouterModelInfo(item);
		info.set(id, parsed);
		if (parsed.contextLength) contexts.set(id, parsed.contextLength);
	}
	return { ids, contexts, info };
}

/** Os três caminhos usam o mesmo inflight, stale e cooldown de 30s. */
export function createOpenRouterCatalog(fetchModels: typeof fetch = fetch, now = Date.now) {
	const catalog = createModelCatalogCache(() => loadModels(fetchModels), {
		now,
		onError: () => console.error("OpenRouter model catalog unavailable"),
	});
	return {
		isKnownOpenRouterModel: async (id: string) => (await catalog.get())?.ids.has(id) ?? false,
		getOpenRouterContextLength: async (id: string) => (await catalog.get())?.contexts.get(id) ?? null,
		/** Metadados do catálogo para a fonte única de capacidades (`undefined` = catálogo fora do ar ou id ausente). */
		catalogInfo: async (id: string) => (await catalog.get())?.info.get(id),
		supportsImageInput: async (id: string) => getModelCapabilities(id, (await catalog.get())?.info.get(id)).vision,
	};
}
const catalog = createOpenRouterCatalog();
export const isKnownOpenRouterModel = catalog.isKnownOpenRouterModel;
export const getOpenRouterContextLength = catalog.getOpenRouterContextLength;
export const supportsImageInput = catalog.supportsImageInput;
export const openRouterCatalogInfo = catalog.catalogInfo;
