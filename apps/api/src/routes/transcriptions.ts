import { Hono } from "hono";
import { getAccountConfig } from "@workspace/db";
import {
	OPENAI_STT_MODELS,
	applyUserSttModel,
	createModelCatalogCache,
	fetchOpenRouterTranscriptionModels,
	readSttConfig,
	transcribeAudio,
	TranscriptionError,
	type SttConfig,
	type SttErrorCode,
} from "@workspace/llm";
import { parseAccountConfig, type TranscriptionModel, type TranscriptionModelsResponse } from "@workspace/shared";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
/** Teto do ditado no cliente é 2 min; folga pequena para o envelope. */
export const MAX_AUDIO_DURATION_MS = 125_000;
const MAX_MULTIPART_BYTES = MAX_AUDIO_BYTES + 64 * 1024;
const RATE_WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const ALLOWED_MIME = /^audio\/(webm|ogg|mp4|x-m4a|m4a|aac|mpeg|mp3|wav|x-wav|wave|flac)$/;

/** Janela fixa por usuário. */
function createLimiter() {
	const attempts = new Map<string, { count: number; expires: number }>();
	return (userId: string, now = Date.now()): boolean => {
		const row = attempts.get(userId);
		if (!row || row.expires <= now) {
			attempts.set(userId, { count: 1, expires: now + RATE_WINDOW_MS });
			return true;
		}
		if (row.count >= MAX_PER_WINDOW) return false;
		row.count += 1;
		return true;
	};
}

async function readLimited(request: Request): Promise<Uint8Array | null> {
	const reader = request.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_MULTIPART_BYTES) {
				await reader.cancel().catch(() => undefined);
				return null;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const output = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
	return output;
}

/** Mensagem amigável por motivo; nunca repassa o texto do provedor. */
export function friendlyError(error: unknown): { message: string; status: 502 | 504 | 429 | 503; code: SttErrorCode } {
	const code: SttErrorCode = error instanceof TranscriptionError ? error.code : "stt_unknown";
	switch (code) {
		case "stt_rate_limited":
			return { code, status: 429, message: "O serviço de transcrição está ocupado. Tente de novo em instantes." };
		case "stt_auth":
			return { code, status: 503, message: "Transcrição indisponível: a chave do provedor foi recusada." };
		case "stt_provider_not_allowed":
			return { code, status: 503, message: "Nenhum provedor deste modelo está liberado na conta do OpenRouter. Escolha outro Modelo de ditado em Configurações > Modelos." };
		case "stt_model_unavailable":
			return { code, status: 503, message: "O modelo de ditado não está disponível. Escolha outro em Configurações > Modelos." };
		case "stt_unsupported_format":
			return { code, status: 502, message: "O provedor não aceitou o formato do áudio." };
		case "stt_timeout":
			return { code, status: 504, message: "A transcrição demorou demais. Tente um ditado mais curto." };
		case "stt_network":
		case "stt_provider_5xx":
			return { code, status: 502, message: "O serviço de transcrição está instável. Tente de novo em instantes." };
		default:
			return { code, status: 502, message: "Não consegui transcrever o áudio agora." };
	}
}

function languageHint(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const base = value.trim().split("-")[0]?.toLowerCase() ?? "";
	return /^[a-z]{2,3}$/.test(base) ? base : undefined;
}

/** Catálogo de transcrição do OpenRouter: mesmo padrão do chat (single-flight, stale em falha, cooldown). */
const openRouterCatalog = createModelCatalogCache(() => fetchOpenRouterTranscriptionModels(), {
	onError: () => console.error("OpenRouter transcription catalog unavailable"),
});

/** Escolha de ditado da conta; falha de leitura não derruba o ditado (vale o modelo do servidor). */
async function readUserSttModel(userId: string): Promise<string | undefined> {
	try {
		return parseAccountConfig(await getAccountConfig(userId)).models?.stt;
	} catch {
		console.error("transcription: could not read account stt model");
		return undefined;
	}
}

/** Linha de log estruturada: nunca inclui áudio, texto, chave nem mensagem do provedor. */
export function sttLogLine(f: { user: string; provider?: string; model?: string; mime?: string; bytes?: number; ms: number; status: number | string; erro?: string }): string {
	return `[stt] user=${f.user} provider=${f.provider ?? "-"} model=${f.model ?? "-"} mime=${f.mime || "-"} bytes=${f.bytes ?? 0} ms=${Math.round(f.ms)} status=${f.status} erro=${f.erro ?? "-"}`;
}

export function createTranscriptionRoutes(dependencies: {
	getConfig?: () => SttConfig | null;
	transcribe?: typeof transcribeAudio;
	/** Modelo de ditado escolhido pelo usuário da sessão (sempre pelo `userId` dela). */
	getUserModel?: (userId: string) => Promise<string | undefined>;
	getCatalog?: () => Promise<TranscriptionModel[] | null>;
} = {}) {
	const app = new Hono<AuthEnv>();
	const allow = createLimiter();
	const getConfig = dependencies.getConfig ?? (() => readSttConfig());

	const getUserModel = dependencies.getUserModel ?? readUserSttModel;
	const getCatalog = dependencies.getCatalog ?? openRouterCatalog.get;

	/** Config do servidor com o modelo que ESTE usuário escolheu (se compatível com o provedor). */
	async function configFor(userId: string): Promise<SttConfig | null> {
		const base = getConfig();
		return base ? applyUserSttModel(base, await getUserModel(userId)) : null;
	}

	app.get("/v1/transcriptions/status", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const config = await configFor(userId);
		return c.json(config ? { available: true, model: config.model } : { available: false });
	});

	app.get("/v1/transcriptions/models", async (c) => {
		const config = getConfig();
		if (!config) return c.json({ error: "Transcrição não configurada no servidor." }, 503);
		const provider = config.provider === "openrouter" ? "openrouter" : "openai";
		const models = provider === "openai" ? [...OPENAI_STT_MODELS] : await getCatalog();
		if (models === null) return c.json({ error: "Failed to list transcription models" }, 502);
		return c.json({ provider, defaultModel: config.model, models } satisfies TranscriptionModelsResponse);
	});

	app.post("/v1/transcriptions", async (c) => {
		const startedAt = Date.now();
		const { userId } = scopeFor(c.get("session"));
		const config = await configFor(userId);
		if (!config) return c.json({ error: "Transcrição não configurada no servidor." }, 503);
		const provider = config.provider ?? "openai";
		const reject = (status: 400 | 413 | 415 | 429, error: string, erro: string, extra: { mime?: string; bytes?: number } = {}) => {
			console.error(sttLogLine({ user: userId, provider, model: config.model, ms: Date.now() - startedAt, status, erro, ...extra }));
			return c.json({ error }, status);
		};
		if (!allow(userId)) return reject(429, "Muitos ditados seguidos. Aguarde um instante.", "rate_limit_local");
		const contentType = c.req.header("Content-Type") ?? "";
		if (!/^multipart\/form-data\s*;/i.test(contentType)) return reject(400, "multipart/form-data obrigatório", "not_multipart");
		const declared = Number(c.req.header("Content-Length"));
		if (Number.isFinite(declared) && declared > MAX_MULTIPART_BYTES) return reject(413, "Áudio maior que 10 MB", "too_large_declared", { bytes: declared });
		const raw = await readLimited(c.req.raw);
		if (!raw) return reject(413, "Áudio maior que 10 MB", "too_large_stream");
		let file: File | null = null;
		let language: string | undefined;
		let durationMs = 0;
		try {
			const form = await new Request("http://localhost/t", { method: "POST", headers: { "Content-Type": contentType }, body: Uint8Array.from(raw) }).formData();
			const value = form.get("file");
			file = value instanceof File ? value : null;
			language = languageHint(form.get("language"));
			durationMs = Number(form.get("durationMs") ?? 0);
		} catch { return reject(400, "Multipart inválido", "bad_multipart", { bytes: raw.byteLength }); }
		if (!file || file.size === 0) return reject(400, "Áudio obrigatório", "empty_audio", { bytes: raw.byteLength });
		if (file.size > MAX_AUDIO_BYTES) return reject(413, "Áudio maior que 10 MB", "too_large", { bytes: file.size });
		const mime = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
		if (!ALLOWED_MIME.test(mime)) return reject(415, "Formato de áudio não suportado", "bad_mime", { mime: file.type, bytes: file.size });
		if (Number.isFinite(durationMs) && durationMs > MAX_AUDIO_DURATION_MS) return reject(413, "Ditado maior que 2 minutos", "too_long", { mime, bytes: file.size });
		try {
			const { text } = await (dependencies.transcribe ?? transcribeAudio)({
				audio: new Uint8Array(await file.arrayBuffer()),
				mime,
				config,
				language,
			});
			console.info(sttLogLine({ user: userId, provider, model: config.model, mime, bytes: file.size, ms: Date.now() - startedAt, status: 200 }));
			return c.json({ text });
		} catch (error) {
			const { message, status, code } = friendlyError(error);
			// Só código e status: nunca a chave, o áudio nem o texto do provedor.
			const upstream = error instanceof TranscriptionError ? error.status : "n/a";
			console.error(sttLogLine({ user: userId, provider, model: config.model, mime, bytes: file.size, ms: Date.now() - startedAt, status, erro: `${code} upstream=${upstream}` }));
			return c.json({ error: message }, status);
		}
	});
	return app;
}
