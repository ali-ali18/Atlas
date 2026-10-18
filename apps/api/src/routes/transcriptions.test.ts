/** POST /v1/transcriptions: auth, limites, MIME, texto e erro sanitizado. Provedor dublado, sem rede. */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";

const { Hono } = await import("hono");
const { TranscriptionError } = await import("@workspace/llm");
const { createTranscriptionRoutes, MAX_AUDIO_BYTES } = await import("./transcriptions.js");
const { requireUser } = await import("../middleware/auth.js");

const CONFIG = { apiKey: "sk-super-secret", baseUrl: "https://stt.test/v1", model: "m" };

function appFor(userId: string, deps: Parameters<typeof createTranscriptionRoutes>[0] = {}) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		(c as unknown as { set: (k: string, v: unknown) => void }).set("session", { user: { id: userId } });
		await next();
	});
	app.route("/", createTranscriptionRoutes({ getConfig: () => CONFIG, getUserModel: async () => undefined, ...deps }));
	return app;
}

function form(file: File | null, extra: Record<string, string> = {}) {
	const body = new FormData();
	if (file) body.set("file", file);
	for (const [k, v] of Object.entries(extra)) body.set(k, v);
	return { method: "POST", body } as const;
}
const audio = (type = "audio/webm;codecs=opus", size = 100) => new File([new Uint8Array(size).fill(1)], "a.webm", { type });

test("devolve o texto e repassa idioma e MIME limpo ao provedor", async () => {
	let seen: { mime: string; language?: string } | undefined;
	const app = appFor("u1", { transcribe: async (p) => { seen = { mime: p.mime, language: p.language }; return { text: "olá" }; } });
	const res = await app.request("/v1/transcriptions", form(audio(), { language: "pt-BR" }));
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { text: "olá" });
	assert.deepEqual(seen, { mime: "audio/webm", language: "pt" });
});

test("sem sessão (requireUser): 401 e o provedor não é chamado", async () => {
	let called = false;
	const app = new Hono();
	app.use("/v1/*", requireUser);
	app.route("/", createTranscriptionRoutes({ getConfig: () => CONFIG, getUserModel: async () => undefined, transcribe: async () => { called = true; return { text: "x" }; } }));
	const res = await app.request("/v1/transcriptions", form(audio()));
	assert.equal(res.status, 401);
	assert.equal(called, false);
});

test("rejeita áudio grande (413), MIME errado (415), ausente (400) e duração acima de 2 min (413)", async () => {
	const app = appFor("u2", { transcribe: async () => ({ text: "x" }) });
	assert.equal((await app.request("/v1/transcriptions", form(audio("audio/webm", MAX_AUDIO_BYTES + 1)))).status, 413);
	assert.equal((await app.request("/v1/transcriptions", form(audio("image/png")))).status, 415);
	assert.equal((await app.request("/v1/transcriptions", form(null))).status, 400);
	assert.equal((await app.request("/v1/transcriptions", form(audio(), { durationMs: "200000" }))).status, 413);
});

test("erro do provedor: mensagem amigável, sem vazar chave nem texto do provedor", async () => {
	const app = appFor("u3", { transcribe: async () => { throw new TranscriptionError("invalid key sk-super-secret", 401); } });
	const res = await app.request("/v1/transcriptions", form(audio()));
	const text = await res.text();
	assert.equal(res.status, 503);
	assert.ok(!text.includes("sk-super-secret"));
	assert.match(text, /indisponível/);
});

test("sem STT configurado: POST 503 e status available=false", async () => {
	const app = appFor("u4", { getConfig: () => null });
	assert.equal((await app.request("/v1/transcriptions", form(audio()))).status, 503);
	assert.deepEqual(await (await app.request("/v1/transcriptions/status")).json(), { available: false });
});

test("status available=true quando configurado", async () => {
	assert.deepEqual(await (await appFor("u5").request("/v1/transcriptions/status")).json(), { available: true, model: "m" });
});

test("limite por usuário: 21ª chamada na janela recebe 429", async () => {
	const app = appFor("u6", { transcribe: async () => ({ text: "x" }) });
	for (let i = 0; i < 20; i++) assert.equal((await app.request("/v1/transcriptions", form(audio()))).status, 200);
	assert.equal((await app.request("/v1/transcriptions", form(audio()))).status, 429);
});

const OR_CONFIG = { apiKey: "sk-x", baseUrl: "https://openrouter.test/api/v1", model: "openai/whisper-large-v3", provider: "openrouter" as const };
const OA_CONFIG = { apiKey: "sk-x", baseUrl: "https://stt.test/v1", model: "gpt-4o-mini-transcribe", provider: "openai" as const };

test("ditado usa o modelo escolhido pelo usuário da sessão e o status o informa", async () => {
	const chosen: Record<string, string> = { alice: "elevenlabs/scribe-v2" };
	const sent: string[] = [];
	const deps = {
		getConfig: () => OR_CONFIG,
		getUserModel: async (id: string) => chosen[id],
		transcribe: async (p: { config: { model: string } }) => { sent.push(p.config.model); return { text: "ok" }; },
	};
	const a = appFor("alice", deps as never);
	assert.equal((await a.request("/v1/transcriptions", form(audio()))).status, 200);
	assert.deepEqual(await (await a.request("/v1/transcriptions/status")).json(), { available: true, model: "elevenlabs/scribe-v2" });
	// usuário B não herda a escolha de A: vale o modelo do servidor
	const b = appFor("bob", deps as never);
	assert.equal((await b.request("/v1/transcriptions", form(audio()))).status, 200);
	assert.deepEqual(await (await b.request("/v1/transcriptions/status")).json(), { available: true, model: "openai/whisper-large-v3" });
	assert.deepEqual(sent, ["elevenlabs/scribe-v2", "openai/whisper-large-v3"]);
});

test("escolha incompatível com o provedor OpenAI direto é ignorada", async () => {
	let seen = "";
	const app = appFor("carol", { getConfig: () => OA_CONFIG, getUserModel: async () => "elevenlabs/scribe-v2", transcribe: async (p) => { seen = p.config.model; return { text: "x" }; } });
	await app.request("/v1/transcriptions", form(audio()));
	assert.equal(seen, "gpt-4o-mini-transcribe");
});

test("GET /v1/transcriptions/models: OpenRouter lista o catálogo e informa o padrão", async () => {
	const models = [{ id: "openai/whisper-large-v3", name: "Whisper", vendor: "openai", pricePerMinuteUsd: 0.00045 }];
	const app = appFor("u7", { getConfig: () => OR_CONFIG, getCatalog: async () => models });
	const res = await app.request("/v1/transcriptions/models");
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { provider: "openrouter", defaultModel: "openai/whisper-large-v3", models });
});

test("GET /v1/transcriptions/models: OpenAI direto devolve a lista fixa, sem consultar catálogo", async () => {
	const app = appFor("u8", { getConfig: () => OA_CONFIG, getCatalog: async () => { throw new Error("não deveria consultar"); } });
	const body = (await (await app.request("/v1/transcriptions/models")).json()) as { provider: string; models: Array<{ id: string }> };
	assert.equal(body.provider, "openai");
	assert.deepEqual(body.models.map((m) => m.id), ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"]);
});

test("GET /v1/transcriptions/models: sem STT = 503; catálogo fora do ar = 502; sem sessão = 401", async () => {
	assert.equal((await appFor("u9", { getConfig: () => null }).request("/v1/transcriptions/models")).status, 503);
	assert.equal((await appFor("u9", { getConfig: () => OR_CONFIG, getCatalog: async () => null }).request("/v1/transcriptions/models")).status, 502);
	const open = new Hono();
	open.use("/v1/*", requireUser);
	open.route("/", createTranscriptionRoutes({ getConfig: () => OR_CONFIG, getCatalog: async () => [] }));
	assert.equal((await open.request("/v1/transcriptions/models")).status, 401);
});

test("catálogo padrão consulta output_modalities=transcription uma vez (cache)", async (t) => {
	const previous = globalThis.fetch;
	const urls: string[] = [];
	globalThis.fetch = (async (url: string) => {
		urls.push(String(url));
		return Response.json({ data: [{ id: "openai/whisper-large-v3", name: "OpenAI: Whisper Large V3", pricing: { prompt: "0.0000075" } }] });
	}) as unknown as typeof fetch;
	t.after(() => { globalThis.fetch = previous; });
	const app = appFor("u10", { getConfig: () => OR_CONFIG });
	const [x, y] = await Promise.all([app.request("/v1/transcriptions/models"), app.request("/v1/transcriptions/models")]);
	const body = (await x.json()) as { models: Array<{ id: string; pricePerMinuteUsd: number }> };
	assert.equal(y.status, 200);
	assert.equal(body.models[0]?.pricePerMinuteUsd, 0.00045);
	await app.request("/v1/transcriptions/models");
	assert.deepEqual(urls, ["https://openrouter.ai/api/v1/models?output_modalities=transcription"]);
});

test("códigos do provedor viram mensagens específicas e o log leva só o código", async () => {
	const logged: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => { logged.push(args.join(" ")); };
	try {
		const cases: Array<[number, string, number, RegExp, string]> = [
			[404, "No allowed providers are available for the selected model. key sk-super-secret", 503, /provedor deste modelo/, "stt_provider_not_allowed"],
			[401, "bad key sk-super-secret", 503, /chave do provedor/, "stt_auth"],
			[400, "Unsupported audio format", 502, /formato do áudio/, "stt_unsupported_format"],
			[429, "slow down", 429, /ocupado/, "stt_rate_limited"],
		];
		for (const [upstream, detail, status, pattern, code] of cases) {
			const app = appFor(`u-code-${code}`, { transcribe: async () => { throw new TranscriptionError(detail, upstream); } });
			const res = await app.request("/v1/transcriptions", form(audio("audio/webm;codecs=opus")));
			const text = await res.text();
			assert.equal(res.status, status);
			assert.match(text, pattern);
			assert.ok(!text.includes("sk-super-secret"));
			assert.ok(logged.some((line) => line.includes(code)), code);
		}
		assert.ok(!logged.join(" ").includes("sk-super-secret"));
	} finally {
		console.error = original;
	}
});

test("timeout e instabilidade do provedor tem mensagens proprias (504/502) e o log estruturado traz mime, bytes, ms e motivo", async () => {
	const logged: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => { logged.push(args.join(" ")); };
	try {
		const cases: Array<[number, string | undefined, number, RegExp]> = [
			[504, "stt_timeout", 504, /demorou demais/],
			[503, "stt_provider_5xx", 502, /instável/],
			[502, "stt_network", 502, /instável/],
			[400, undefined, 502, /formato|Não consegui/],
		];
		for (const [upstream, code, status, pattern] of cases) {
			const app = appFor(`u-log-${upstream}-${code}`, { transcribe: async () => { throw new TranscriptionError("boom sk-super-secret", upstream, code as never); } });
			const res = await app.request("/v1/transcriptions", form(audio("audio/mp4", 321)));
			assert.equal(res.status, status);
			assert.match(await res.text(), pattern);
		}
		const line = logged.find((l) => l.includes("stt_timeout"))!;
		assert.match(line, /^\[stt\] user=u-log-504-stt_timeout provider=openai model=m mime=audio\/mp4 bytes=321 ms=\d+ status=504 erro=stt_timeout upstream=504$/);
		assert.ok(!logged.join(" ").includes("sk-super-secret"));
	} finally {
		console.error = original;
	}
});

test("formatos de Chrome Android (webm), iOS (mp4/x-m4a) e Firefox (ogg) passam; recusas tambem sao logadas", async () => {
	const logged: string[] = [];
	const originalErr = console.error;
	const originalInfo = console.info;
	console.error = (...args: unknown[]) => { logged.push(args.join(" ")); };
	console.info = (...args: unknown[]) => { logged.push(args.join(" ")); };
	try {
		const app = appFor("u-fmt", { transcribe: async () => ({ text: "ok" }) });
		for (const type of ["audio/webm;codecs=opus", "audio/mp4", "audio/x-m4a", "audio/ogg;codecs=opus"]) {
			assert.equal((await app.request("/v1/transcriptions", form(audio(type)))).status, 200, type);
		}
		assert.equal((await app.request("/v1/transcriptions", form(audio("video/mp4")))).status, 415);
		assert.ok(logged.some((l) => /status=200 erro=-$/.test(l)));
		assert.ok(logged.some((l) => l.includes("status=415") && l.includes("erro=bad_mime")));
	} finally {
		console.error = originalErr;
		console.info = originalInfo;
	}
});
