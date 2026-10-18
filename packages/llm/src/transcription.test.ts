import { describe, expect, it } from "vitest";
import { TranscriptionError, audioFormatFor, classifySttError, readSttConfig, transcribeAudio } from "./transcription.js";

const config = { apiKey: "sk-secret", baseUrl: "https://stt.example.test/v1", model: "m1" };

describe("readSttConfig", () => {
	it("sem chave: null", () => {
		expect(readSttConfig({})).toBeNull();
		expect(readSttConfig({ ATLAS_STT_API_KEY: "  " })).toBeNull();
	});
	it("usa padrões e tira a barra final", () => {
		expect(readSttConfig({ ATLAS_STT_API_KEY: "k" })).toEqual({
			apiKey: "k",
			baseUrl: "https://api.openai.com/v1",
			model: "gpt-4o-mini-transcribe",
			provider: "openai",
		});
		expect(readSttConfig({ ATLAS_STT_API_KEY: "k", ATLAS_STT_BASE_URL: "https://x.test/v1/", ATLAS_STT_MODEL: "whisper-1" }))
			.toMatchObject({ baseUrl: "https://x.test/v1", model: "whisper-1" });
	});
});

describe("transcribeAudio", () => {
	it("envia multipart com modelo, idioma e chave, e devolve o texto", async () => {
		let seen: { url: string; init: RequestInit } | undefined;
		const fetchFn = (async (url: string, init: RequestInit) => {
			seen = { url, init };
			return new Response(JSON.stringify({ text: "  olá mundo " }), { status: 200 });
		}) as unknown as typeof fetch;
		const result = await transcribeAudio({ audio: new Uint8Array([1, 2, 3]), mime: "audio/webm", config, language: "pt", fetchFn });
		expect(result.text).toBe("olá mundo");
		expect(seen?.url).toBe("https://stt.example.test/v1/audio/transcriptions");
		expect((seen?.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-secret");
		const form = seen?.init.body as FormData;
		expect(form.get("model")).toBe("m1");
		expect(form.get("language")).toBe("pt");
		expect((form.get("file") as File).name).toBe("audio.webm");
	});
	it("erro do provedor vira TranscriptionError com status", async () => {
		const fetchFn = (async () => new Response(JSON.stringify({ error: { message: "bad audio" } }), { status: 400 })) as unknown as typeof fetch;
		await expect(transcribeAudio({ audio: new Uint8Array([1]), mime: "audio/ogg", config, fetchFn })).rejects.toMatchObject({ status: 400, message: "bad audio" });
	});
	it("áudio vazio e resposta sem texto falham", async () => {
		await expect(transcribeAudio({ audio: new Uint8Array(), mime: "audio/ogg", config })).rejects.toBeInstanceOf(TranscriptionError);
		const fetchFn = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
		await expect(transcribeAudio({ audio: new Uint8Array([1]), mime: "audio/ogg", config, fetchFn })).rejects.toMatchObject({ status: 502 });
	});
});

describe("readSttConfig: escolha do provedor", () => {
	it("chave STT explícita vence a do OpenRouter", () => {
		expect(readSttConfig({ ATLAS_STT_API_KEY: "s", OPENROUTER_API_KEY: "o" })).toMatchObject({ apiKey: "s", provider: "openai" });
	});
	it("sem chave STT, usa a do OpenRouter com modelo padrão ou o de ATLAS_STT_MODEL", () => {
		expect(readSttConfig({ OPENROUTER_API_KEY: "o" })).toEqual({
			apiKey: "o",
			baseUrl: "https://openrouter.ai/api/v1",
			model: "openai/whisper-large-v3",
			provider: "openrouter",
		});
		expect(readSttConfig({ OPENROUTER_API_KEY: "o", ATLAS_STT_MODEL: "qwen/qwen3-asr-1.7b" })?.model).toBe("qwen/qwen3-asr-1.7b");
	});
	it("ATLAS_STT_PROVIDER força a escolha", () => {
		const env = { ATLAS_STT_API_KEY: "s", OPENROUTER_API_KEY: "o" };
		expect(readSttConfig({ ...env, ATLAS_STT_PROVIDER: "openrouter" })).toMatchObject({ apiKey: "o", provider: "openrouter" });
		expect(readSttConfig({ OPENROUTER_API_KEY: "o", ATLAS_STT_PROVIDER: "openai" })).toBeNull();
		expect(readSttConfig({ ATLAS_STT_PROVIDER: "openrouter" })).toBeNull();
	});
	it("nenhuma chave: null", () => {
		expect(readSttConfig({ OPENROUTER_API_KEY: " " })).toBeNull();
	});
});

describe("audioFormatFor", () => {
	it("mapeia MIME do navegador para o format aceito", () => {
		expect(audioFormatFor("audio/webm;codecs=opus")).toBe("webm");
		expect(audioFormatFor("audio/ogg")).toBe("ogg");
		expect(audioFormatFor("audio/mp4")).toBe("m4a");
		expect(audioFormatFor("audio/mpeg")).toBe("mp3");
		expect(audioFormatFor("audio/x-wav")).toBe("wav");
		expect(audioFormatFor("application/x-unknown")).toBe("webm");
	});
});

describe("transcribeAudio via OpenRouter", () => {
	const orConfig = { apiKey: "or-secret", baseUrl: "https://openrouter.ai/api/v1", model: "openai/whisper-large-v3", provider: "openrouter" as const };
	it("envia JSON com base64 cru, format, model e language", async () => {
		let seen: { url: string; init: RequestInit } | undefined;
		const fetchFn = (async (url: string, init: RequestInit) => {
			seen = { url, init };
			return new Response(JSON.stringify({ text: " oi ", usage: { seconds: 2, cost: 0.1 } }), { status: 200 });
		}) as unknown as typeof fetch;
		const result = await transcribeAudio({ audio: new Uint8Array([1, 2, 3, 250]), mime: "audio/webm;codecs=opus", config: orConfig, language: "pt", fetchFn });
		expect(result.text).toBe("oi");
		expect(seen?.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
		const headers = seen?.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer or-secret");
		expect(headers["Content-Type"]).toBe("application/json");
		expect(JSON.parse(seen?.init.body as string)).toEqual({
			model: "openai/whisper-large-v3",
			input_audio: { data: Buffer.from([1, 2, 3, 250]).toString("base64"), format: "webm" },
			language: "pt",
		});
	});
	it("sem idioma, omite language; mp4 vira m4a", async () => {
		let body = "";
		const fetchFn = (async (_u: string, init: RequestInit) => {
			body = init.body as string;
			return new Response(JSON.stringify({ text: "x" }), { status: 200 });
		}) as unknown as typeof fetch;
		await transcribeAudio({ audio: new Uint8Array([1]), mime: "audio/mp4", config: orConfig, fetchFn });
		expect(JSON.parse(body)).not.toHaveProperty("language");
		expect(JSON.parse(body).input_audio.format).toBe("m4a");
	});
	it("erro devolve a mensagem do provedor sem a chave nem o áudio", async () => {
		const fetchFn = (async () => new Response(JSON.stringify({ error: { message: "upstream timeout" } }), { status: 504 })) as unknown as typeof fetch;
		const error = await transcribeAudio({ audio: new Uint8Array([9, 9]), mime: "audio/webm", config: orConfig, fetchFn }).catch((e) => e);
		expect(error).toBeInstanceOf(TranscriptionError);
		expect(error.status).toBe(504);
		expect(error.message).toBe("upstream timeout");
		expect(error.message).not.toContain("or-secret");
	});
});

describe("nova tentativa em falha transitória", () => {
	const ok = () => new Response(JSON.stringify({ text: "ok" }), { status: 200 });
	it("5xx do provedor: tenta de novo uma vez e recupera", async () => {
		let calls = 0;
		const fetchFn = (async () => (++calls === 1 ? new Response("{}", { status: 503 }) : ok())) as unknown as typeof fetch;
		expect((await transcribeAudio({ audio: new Uint8Array([1]), mime: "audio/webm", config, fetchFn, retryDelayMs: 0 })).text).toBe("ok");
		expect(calls).toBe(2);
	});
	it("erro de rede vira stt_network e tenta de novo", async () => {
		let calls = 0;
		const fetchFn = (async () => { calls += 1; throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
		const error = await transcribeAudio({ audio: new Uint8Array([1]), mime: "audio/webm", config, fetchFn, retryDelayMs: 0 }).catch((e) => e);
		expect(error.code).toBe("stt_network");
		expect(calls).toBe(2);
	});
	it("401, 400 e timeout não repetem", async () => {
		for (const status of [401, 400, 504]) {
			let calls = 0;
			const fetchFn = (async () => { calls += 1; return new Response("{}", { status }); }) as unknown as typeof fetch;
			await transcribeAudio({ audio: new Uint8Array([1]), mime: "audio/webm", config, fetchFn, retryDelayMs: 0 }).catch(() => undefined);
			expect(calls).toBe(1);
		}
	});
});

describe("classificação de erros do STT", () => {
	it("mapeia status e mensagem do provedor para códigos estáveis", () => {
		const notAllowed = "No allowed providers are available for the selected model. Providers serving openai/whisper-large-v3: groq, but your account's allowed-providers setting permits only: azure";
		expect(classifySttError(404, notAllowed)).toBe("stt_provider_not_allowed");
		expect(classifySttError(404, "model not found")).toBe("stt_model_unavailable");
		expect(classifySttError(401)).toBe("stt_auth");
		expect(classifySttError(403)).toBe("stt_auth");
		expect(classifySttError(429)).toBe("stt_rate_limited");
		expect(classifySttError(400, "Unsupported audio format")).toBe("stt_unsupported_format");
		expect(classifySttError(400, "bad field")).toBe("stt_bad_request");
		expect(classifySttError(503)).toBe("stt_provider_5xx");
	});

	it("transcribeAudio lança TranscriptionError com o código do 404 de provedores não permitidos", async () => {
		const fetchFn = (async () =>
			new Response(JSON.stringify({ error: { message: "No allowed providers are available for the selected model." } }), { status: 404 })) as typeof fetch;
		const error = await transcribeAudio({
			audio: new Uint8Array([1, 2]),
			mime: "audio/webm;codecs=opus",
			config: { apiKey: "k", baseUrl: "https://x.test/v1", model: "openai/whisper-large-v3", provider: "openrouter" },
			fetchFn,
		}).catch((e) => e);
		expect(error).toBeInstanceOf(TranscriptionError);
		expect(error.code).toBe("stt_provider_not_allowed");
	});

	it("falha de rede/timeout vira stt_timeout sem vazar a causa", async () => {
		const fetchFn = (async () => { throw Object.assign(new Error("secret-ish"), { name: "TimeoutError" }); }) as typeof fetch;
		const error = await transcribeAudio({
			audio: new Uint8Array([1]),
			mime: "audio/wav",
			config: { apiKey: "k", baseUrl: "https://x.test/v1", model: "m" },
			fetchFn,
		}).catch((e) => e);
		expect(error.code).toBe("stt_timeout");
		expect(error.message).not.toContain("secret-ish");
	});

	it("corpo OpenRouter segue a doc: model, input_audio {data base64 cru, format} e language; MIME com codecs vira webm", async () => {
		let body: Record<string, unknown> = {};
		const fetchFn = (async (_url: string, init: RequestInit) => {
			body = JSON.parse(init.body as string);
			return new Response(JSON.stringify({ text: " oi " }), { status: 200 });
		}) as unknown as typeof fetch;
		const result = await transcribeAudio({
			audio: new Uint8Array([1, 2, 3]),
			mime: "audio/webm;codecs=opus",
			config: { apiKey: "k", baseUrl: "https://x.test/v1", model: "openai/whisper-large-v3", provider: "openrouter" },
			language: "pt",
			fetchFn,
		});
		expect(result.text).toBe("oi");
		expect(body).toEqual({ model: "openai/whisper-large-v3", input_audio: { data: "AQID", format: "webm" }, language: "pt" });
	});
});
