import { formatModelRef, type ApiKeyProvider, type ProviderModel } from "@workspace/shared";
import { ANTHROPIC_API_BASE_URL, ANTHROPIC_VERSION, anthropicAuthHeaders } from "./anthropic/stream.js";
import { OPENCODE_GO_BASE_URL, goProtocolFor, type GoProtocol } from "./opencode/routing.js";
import { OPENCODE_USER_AGENT } from "./opencode/stream.js";
import { ProviderApiError, classifyProviderHttpError } from "./provider-errors.js";

export type ApiKeyCatalog = { models: ProviderModel[]; protocols: Record<string, GoProtocol> };

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
const positiveInt = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

async function getJson(provider: ApiKeyProvider, url: string, headers: Record<string, string>, fetchFn: typeof fetch): Promise<unknown> {
	let response: Response;
	try {
		response = await fetchFn(url, { headers: { Accept: "application/json", ...headers }, redirect: "error", signal: AbortSignal.timeout(15_000) });
	} catch {
		throw new ProviderApiError(provider, 502, "network_error");
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		payload = undefined;
	}
	if (!response.ok) throw classifyProviderHttpError(provider, response.status, payload);
	return payload;
}

/** `GET /v1/models` da Anthropic, paginado. Modelos aceitam texto, imagem e ferramentas. */
export async function fetchAnthropicModels(apiKey: string, options: { fetch?: typeof fetch; baseUrl?: string } = {}): Promise<ProviderModel[]> {
	const fetchFn = options.fetch ?? fetch;
	const base = options.baseUrl ?? ANTHROPIC_API_BASE_URL;
	const models: ProviderModel[] = [];
	let after: string | undefined;
	for (let page = 0; page < 5; page += 1) {
		const url = `${base}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`;
		const body = record(await getJson("anthropic", url, { ...anthropicAuthHeaders("x-api-key", apiKey), "anthropic-version": ANTHROPIC_VERSION }, fetchFn));
		const rows = Array.isArray(body.data) ? body.data : [];
		for (const row of rows) {
			const item = record(row);
			if (typeof item.id !== "string") continue;
			let id: string;
			try {
				id = formatModelRef("anthropic", item.id);
			} catch {
				continue;
			}
			models.push({
				id,
				name: typeof item.display_name === "string" && item.display_name ? item.display_name : item.id,
				provider: "anthropic",
				vendor: "anthropic",
				contextLength: positiveInt(item.max_input_tokens),
				inputModalities: ["text", "image"],
				outputModalities: ["text"],
				capabilities: { tools: true, vision: true },
			});
		}
		if (body.has_more !== true || typeof body.last_id !== "string") break;
		after = body.last_id;
	}
	return models;
}

function modalities(value: unknown): string[] | undefined {
	const list = Array.isArray(value) ? value : Array.isArray(record(value).input) ? (record(value).input as unknown[]) : undefined;
	const out = list?.filter((item): item is string => typeof item === "string");
	return out?.length ? out : undefined;
}

/** Lê o catálogo do OpenCode Go (formato OpenAI `{data:[{id,...}]}`); Gemini fica oculto por ora. */
export function parseOpencodeGoModels(json: unknown): ApiKeyCatalog {
	const rows = Array.isArray(record(json).data) ? (record(json).data as unknown[]) : Array.isArray(json) ? json : [];
	const models: ProviderModel[] = [];
	const protocols: Record<string, GoProtocol> = {};
	for (const row of rows) {
		const item = record(row);
		if (typeof item.id !== "string") continue;
		const protocol = goProtocolFor(item.id, item);
		if (protocol === "google") continue;
		let id: string;
		try {
			id = formatModelRef("opencode-go", item.id);
		} catch {
			continue;
		}
		protocols[item.id] = protocol;
		const input = modalities(item.input_modalities) ?? modalities(item.modalities);
		models.push({
			id,
			name: typeof item.name === "string" && item.name ? item.name : item.id,
			provider: "opencode-go",
			vendor: "opencode-go",
			contextLength: positiveInt(item.context_length) ?? positiveInt(item.context_window) ?? positiveInt(item.max_context),
			...(input ? { inputModalities: input } : {}),
			capabilities: input ? { tools: true, vision: input.includes("image") } : "unknown",
		});
	}
	return { models, protocols };
}

export async function fetchOpencodeGoModels(apiKey: string, options: { fetch?: typeof fetch; baseUrl?: string } = {}): Promise<ApiKeyCatalog> {
	const url = `${(options.baseUrl ?? OPENCODE_GO_BASE_URL).replace(/\/+$/, "")}/models`;
	const json = await getJson("opencode-go", url, { Authorization: `Bearer ${apiKey}`, "User-Agent": OPENCODE_USER_AGENT }, options.fetch ?? fetch);
	return parseOpencodeGoModels(json);
}
