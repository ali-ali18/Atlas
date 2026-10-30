import { OpenRouterError } from "./openrouter.js";
import { modelCallSignal } from "./signal.js";

const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";

/** Modelo padrão de embedding (1536 dims). Dimensão trava o schema: trocar
 * depois exige re-embed de tudo. */
export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const DEFAULT_EMBEDDING_DIMS = 1536;

export type EmbedTextParams = {
	text: string;
	model?: string;
	apiKey: string;
	signal?: AbortSignal;
	timeoutMs?: number;
};

export type EmbedTextResult = {
	embedding: number[];
	model: string;
	tokens?: number;
};

type OpenRouterEmbeddingsResponse = {
	data?: Array<{ embedding?: number[] }>;
	model?: string;
	usage?: {
		prompt_tokens?: number;
		total_tokens?: number;
	};
	error?: { message?: string };
};

const EMBEDDING_HEADERS = (apiKey: string) => ({
	Authorization: `Bearer ${apiKey}`,
	"Content-Type": "application/json",
	"HTTP-Referer": "https://github.com/ali-ali18/Atlas",
	"X-Title": "Atlas",
});

/** Gera o embedding de um texto curto (fato de memória, resumo, query). */
export async function embedText(
	params: EmbedTextParams,
): Promise<EmbedTextResult> {
	const text = params.text.trim();
	if (!text) throw new OpenRouterError("embedText: texto vazio", 400);
	const model = params.model ?? DEFAULT_EMBEDDING_MODEL;

	const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
		method: "POST",
		headers: EMBEDDING_HEADERS(params.apiKey),
		body: JSON.stringify({ model, input: text }),
		signal: modelCallSignal(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		let detail = `OpenRouter embeddings failed with status ${response.status}`;
		try {
			const body = (await response.json()) as OpenRouterEmbeddingsResponse;
			detail = body.error?.message ?? detail;
		} catch {
			// ignore
		}
		throw new OpenRouterError(detail, response.status);
	}

	const body = (await response.json()) as OpenRouterEmbeddingsResponse;
	const embedding = body.data?.[0]?.embedding;
	if (!Array.isArray(embedding) || embedding.length === 0) {
		throw new OpenRouterError("OpenRouter returned no embedding", 502);
	}
	return {
		embedding,
		model: body.model ?? model,
		tokens: body.usage?.prompt_tokens ?? body.usage?.total_tokens,
	};
}
