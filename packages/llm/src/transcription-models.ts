import type { TranscriptionModel } from "@workspace/shared";
import { OPENROUTER_STT_BASE_URL, type SttConfig } from "./transcription.js";

/** Lista fixa para o endpoint OpenAI-compatível (`ATLAS_STT_API_KEY`): não há catálogo para consultar. */
export const OPENAI_STT_MODELS: readonly TranscriptionModel[] = [
	{ id: "gpt-4o-mini-transcribe", name: "GPT-4o mini Transcribe", vendor: "openai", pricePerMinuteUsd: 0.003 },
	{ id: "gpt-4o-transcribe", name: "GPT-4o Transcribe", vendor: "openai", pricePerMinuteUsd: 0.006 },
	{ id: "whisper-1", name: "Whisper", vendor: "openai", pricePerMinuteUsd: 0.006 },
];

/**
 * `pricing.prompt` dos modelos de transcrição do OpenRouter é US$ por SEGUNDO de áudio
 * (ex.: whisper-large-v3 = 0,0000075/s = US$ 0,00045/min). Premissa: vale para todos os modelos da
 * lista; preço ausente, zero ou inválido vira `null` (a UI não mostra preço mesmo).
 */
export function pricePerMinute(promptPrice: unknown): number | null {
	const perSecond = typeof promptPrice === "string" || typeof promptPrice === "number" ? Number(promptPrice) : NaN;
	if (!Number.isFinite(perSecond) || perSecond <= 0) return null;
	return Math.round(perSecond * 60 * 1e6) / 1e6;
}

/** Lê um item de `GET /api/v1/models?output_modalities=transcription`. Item malformado = `null`. */
export function parseTranscriptionModel(raw: unknown): TranscriptionModel | null {
	if (typeof raw !== "object" || raw === null) return null;
	const record = raw as { id?: unknown; name?: unknown; pricing?: { prompt?: unknown } };
	if (typeof record.id !== "string") return null;
	const id = record.id.trim();
	if (!id || id.startsWith("~")) return null;
	const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : id;
	return {
		id,
		name,
		vendor: id.includes("/") ? id.slice(0, id.indexOf("/")) : "openrouter",
		pricePerMinuteUsd: pricePerMinute(record.pricing?.prompt),
	};
}

export async function fetchOpenRouterTranscriptionModels(fetchFn: typeof fetch = fetch): Promise<TranscriptionModel[]> {
	const response = await fetchFn(`${OPENROUTER_STT_BASE_URL}/models?output_modalities=transcription`, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new Error(`OpenRouter responded ${response.status}`);
	const json = (await response.json()) as { data?: unknown };
	const data = Array.isArray(json.data) ? json.data : [];
	return data.flatMap((item) => {
		const model = parseTranscriptionModel(item);
		return model ? [model] : [];
	});
}

/**
 * Aplica a escolha da conta sobre a config do servidor. Escolha incompatível com o provedor
 * (ex.: conta escolheu um id do OpenRouter e o servidor passou a usar o endpoint OpenAI direto)
 * é ignorada: vale o modelo do servidor.
 */
export function applyUserSttModel(config: SttConfig, userModel: string | undefined): SttConfig {
	const model = userModel?.trim();
	if (!model || model === config.model) return config;
	const compatible =
		config.provider === "openrouter" ? model.includes("/") : OPENAI_STT_MODELS.some((entry) => entry.id === model);
	return compatible ? { ...config, model } : config;
}
