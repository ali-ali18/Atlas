import { Hono } from "hono";
import { createModelCatalogCache } from "@workspace/llm";
import { parseOpenRouterModelInfo, type ListModelsResponse, type ProviderModel } from "@workspace/shared";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const catalog = createModelCatalogCache(fetchModels, {
	onError: () => console.error("OpenRouter model catalog unavailable"),
});

function toModel(raw: unknown): ProviderModel | null {
	if (typeof raw !== "object" || raw === null) return null;
	const record = raw as {
		id?: unknown;
		name?: unknown;
		context_length?: unknown;
		architecture?: { input_modalities?: unknown; output_modalities?: unknown };
	};
	if (typeof record.id !== "string" || record.id.trim().length === 0) {
		return null;
	}
	const id = record.id.trim();
	const provider = id.includes("/") ? id.slice(0, id.indexOf("/")) : "openrouter";
	// Providers com "~" são aliases internos de variantes do OpenRouter.
	if (provider.startsWith("~")) return null;
	const name =
		typeof record.name === "string" && record.name.trim().length > 0
			? record.name.trim()
			: id;
	const info = parseOpenRouterModelInfo(raw);
	const { inputModalities, outputModalities, supportedParameters } = info;
	const capabilities = inputModalities || supportedParameters
		? { ...(inputModalities ? { vision: inputModalities.includes("image") } : {}), ...(supportedParameters ? { tools: supportedParameters.includes("tools") } : {}) }
		: ("unknown" as const);
	return {
		id, name, provider: "openrouter", vendor: provider, capabilities, contextLength: info.contextLength, maxOutputTokens: info.maxOutputTokens,
		...(inputModalities ? { inputModalities } : {}),
		...(outputModalities ? { outputModalities } : {}),
		...(supportedParameters ? { supportedParameters } : {}),
	};
}

async function fetchModels(): Promise<ProviderModel[]> {
	const response = await fetch(OPENROUTER_MODELS_URL, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		throw new Error(`OpenRouter responded ${response.status}`);
	}
	const json = (await response.json()) as { data?: unknown };
	const data = Array.isArray(json.data) ? json.data : [];
	const models: ProviderModel[] = [];
	for (const item of data) {
		const model = toModel(item);
		if (model) models.push(model);
	}
	return models;
}

/**
 * Janela de contexto sem bloquear criação de run: lê só o cache em memória
 * (mesmo de GET /v1/models). Dispara refresh em background quando expirado.
 * Retorna null quando desconhecida — o worker usa fallback 128k.
 */
export function peekModelContextLength(modelId: string | undefined): number | null {
	const id = modelId?.trim();
	if (!id) return null;
	return catalog.peek()?.find((model) => model.id === id)?.contextLength ?? null;
}

export async function isKnownModelId(modelId: string): Promise<boolean | null> {
	const models = await catalog.get();
	return models?.some((model) => model.id === modelId) ?? null;
}

export function refreshModelsCache(): void {
	catalog.peek();
}

export function createModelRoutes(getModels = catalog.get) {
	const app = new Hono();
	app.get("/v1/models", async (c) => {
		const models = await getModels();
		return models === null
			? c.json({ error: "Failed to list models" }, 502)
			: c.json({ models } satisfies ListModelsResponse);
	});
	return app;
}
