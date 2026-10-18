import { modelCallSignal } from "./signal.js";

/** Modelo padrão do provedor OpenAI-compatível (endpoint multipart /audio/transcriptions). */
export const DEFAULT_STT_MODEL = "gpt-4o-mini-transcribe";
export const DEFAULT_STT_BASE_URL = "https://api.openai.com/v1";
/**
 * Padrão no OpenRouter: Whisper large-v3 (multilíngue, inclui pt). Cobrança por
 * duração: US$ 0,0000075/s (~US$ 0,00045/min), conforme a lista de modelos de transcrição.
 */
export const DEFAULT_OPENROUTER_STT_MODEL = "openai/whisper-large-v3";
export const OPENROUTER_STT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_STT_TIMEOUT_MS = 60_000;

export type SttProvider = "openai" | "openrouter";

export type SttConfig = {
	apiKey: string;
	baseUrl: string;
	model: string;
	/** Ausente = "openai" (multipart OpenAI-compatível). */
	provider?: SttProvider;
};

/**
 * Lê a config de STT do env. Sem chave utilizável, devolve null (ditado só no navegador).
 * `ATLAS_STT_PROVIDER` força; senão `ATLAS_STT_API_KEY` (OpenAI-compatível);
 * senão a `OPENROUTER_API_KEY` que o projeto já usa nos LLMs.
 */
export function readSttConfig(env: NodeJS.ProcessEnv = process.env): SttConfig | null {
	const sttKey = env.ATLAS_STT_API_KEY?.trim();
	const openRouterKey = env.OPENROUTER_API_KEY?.trim();
	const forced = env.ATLAS_STT_PROVIDER?.trim().toLowerCase();
	const model = env.ATLAS_STT_MODEL?.trim();
	const provider: SttProvider | null =
		forced === "openai" || forced === "openrouter" ? forced : sttKey ? "openai" : openRouterKey ? "openrouter" : null;
	if (provider === "openrouter") {
		if (!openRouterKey) return null;
		return {
			apiKey: openRouterKey,
			baseUrl: OPENROUTER_STT_BASE_URL,
			model: model || DEFAULT_OPENROUTER_STT_MODEL,
			provider,
		};
	}
	if (provider === "openai") {
		if (!sttKey) return null;
		return {
			apiKey: sttKey,
			baseUrl: (env.ATLAS_STT_BASE_URL?.trim() || DEFAULT_STT_BASE_URL).replace(/\/+$/, ""),
			model: model || DEFAULT_STT_MODEL,
			provider,
		};
	}
	return null;
}

/** Motivo sanitizado da falha (seguro para log: sem chave, sem áudio, sem texto do provedor). */
export type SttErrorCode =
	| "stt_auth"
	| "stt_provider_not_allowed"
	| "stt_model_unavailable"
	| "stt_unsupported_format"
	| "stt_bad_request"
	| "stt_rate_limited"
	| "stt_timeout"
	| "stt_network"
	| "stt_provider_5xx"
	| "stt_unknown";

/** Classifica a resposta de erro do provedor (status + mensagem) num código estável. */
export function classifySttError(status: number, message = ""): SttErrorCode {
	const text = message.toLowerCase();
	if (status === 401 || status === 403) return "stt_auth";
	if (status === 429) return "stt_rate_limited";
	if (status === 408 || status === 504) return "stt_timeout";
	if (status === 404 && /allowed.provider|no allowed providers/.test(text)) return "stt_provider_not_allowed";
	if (status === 404) return "stt_model_unavailable";
	if (status >= 500) return "stt_provider_5xx";
	if (status === 415 || (status >= 400 && /format|codec|unsupported|decode/.test(text))) return "stt_unsupported_format";
	if (status >= 400) return "stt_bad_request";
	return "stt_unknown";
}

/** Erro do provedor de STT. A mensagem nunca carrega a chave nem o áudio. */
export class TranscriptionError extends Error {
	readonly code: SttErrorCode;
	constructor(
		message: string,
		readonly status: number,
		code?: SttErrorCode,
	) {
		super(message);
		this.name = "TranscriptionError";
		this.code = code ?? classifySttError(status, message);
	}
}

export type TranscribeAudioParams = {
	audio: Uint8Array;
	mime: string;
	config: SttConfig;
	/** Dica de idioma ISO-639-1 (ex.: "pt"). */
	language?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetchFn?: typeof fetch;
	/** Pausa antes da única nova tentativa (falha de rede / 5xx do provedor). Padrão 400 ms. */
	retryDelayMs?: number;
};

const FORMATS: Array<[RegExp, string]> = [
	[/webm/, "webm"],
	[/ogg|opus/, "ogg"],
	[/mp4|m4a/, "m4a"],
	[/aac/, "aac"],
	[/flac/, "flac"],
	[/mpeg|mp3/, "mp3"],
	[/wav/, "wav"],
];

/** MIME do navegador → `format` aceito pelo STT (padrão: webm, o que o MediaRecorder do Chrome grava). */
export function audioFormatFor(mime: string): string {
	return FORMATS.find(([pattern]) => pattern.test(mime.toLowerCase()))?.[1] ?? "webm";
}

function fileNameFor(mime: string): string {
	const format = audioFormatFor(mime);
	return `audio.${format === "m4a" ? "mp4" : format}`;
}

function buildRequest(params: TranscribeAudioParams): { headers: Record<string, string>; body: string | FormData } {
	const headers: Record<string, string> = { Authorization: `Bearer ${params.config.apiKey}` };
	if (params.config.provider === "openrouter") {
		// OpenRouter: JSON com o áudio em base64 cru (sem data URI).
		headers["Content-Type"] = "application/json";
		return {
			headers,
			body: JSON.stringify({
				model: params.config.model,
				input_audio: { data: Buffer.from(params.audio).toString("base64"), format: audioFormatFor(params.mime) },
				...(params.language ? { language: params.language } : {}),
			}),
		};
	}
	const form = new FormData();
	form.set("file", new Blob([new Uint8Array(params.audio)], { type: params.mime }), fileNameFor(params.mime));
	form.set("model", params.config.model);
	form.set("response_format", "json");
	if (params.language) form.set("language", params.language);
	return { headers, body: form };
}

/** Falhas que valem uma nova tentativa (a chamada é idempotente): rede e 5xx do provedor, nunca timeout/4xx. */
function isRetryable(error: unknown): boolean {
	return error instanceof TranscriptionError && (error.code === "stt_network" || error.code === "stt_provider_5xx");
}

/** Transcreve um áudio curto. O áudio só trafega em memória; nada é gravado ou logado. Uma nova tentativa em falha transitória. */
export async function transcribeAudio(params: TranscribeAudioParams): Promise<{ text: string }> {
	try {
		return await transcribeOnce(params);
	} catch (error) {
		if (!isRetryable(error) || params.signal?.aborted) throw error;
		await new Promise((resolve) => setTimeout(resolve, params.retryDelayMs ?? 400));
		return transcribeOnce(params);
	}
}

async function transcribeOnce(params: TranscribeAudioParams): Promise<{ text: string }> {
	if (params.audio.byteLength === 0) throw new TranscriptionError("Áudio vazio", 400);
	const { headers, body } = buildRequest(params);

	let response: Response;
	try {
		response = await (params.fetchFn ?? fetch)(`${params.config.baseUrl}/audio/transcriptions`, {
			method: "POST",
			headers,
			body,
			signal: modelCallSignal(params.signal, params.timeoutMs ?? DEFAULT_STT_TIMEOUT_MS),
		});
	} catch (error) {
		const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
		throw new TranscriptionError(timedOut ? "Transcription request timed out" : "Transcription request failed", 504, timedOut ? "stt_timeout" : "stt_network");
	}

	if (!response.ok) {
		let detail = `Transcription failed with status ${response.status}`;
		try {
			const errBody = (await response.json()) as { error?: { message?: string } };
			if (errBody.error?.message) detail = errBody.error.message;
		} catch {
			// ignore
		}
		throw new TranscriptionError(detail, response.status);
	}
	const result = (await response.json()) as { text?: unknown };
	if (typeof result.text !== "string") throw new TranscriptionError("Provider returned no text", 502);
	return { text: result.text.trim() };
}
