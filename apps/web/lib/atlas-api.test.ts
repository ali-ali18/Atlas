import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { buildRunInputBody, createRunInput } from "./atlas-api";

describe("buildRunInputBody (production)", () => {
	it("default: only content included when mode undefined", () => {
		const body = buildRunInputBody({ content: "test" });
		assert.deepStrictEqual(body, { content: "test" }, "only content in body");
	});

	it("includes mode when specified", () => {
		const body = buildRunInputBody({ content: "test", mode: "interrupt" });
		assert.strictEqual(body.mode, "interrupt", "mode passed through");
	});

	it("includes queue mode", () => {
		const body = buildRunInputBody({ content: "test", mode: "queue" });
		assert.strictEqual(body.mode, "queue", "queue mode passed through");
	});

	it("includes join mode explicitly", () => {
		const body = buildRunInputBody({ content: "test", mode: "join" });
		assert.strictEqual(body.mode, "join", "join mode passed through");
	});

	it("omits empty attachments", () => {
		const body = buildRunInputBody({ content: "test", attachments: [] });
		assert.strictEqual(
			body.attachments,
			undefined,
			"empty attachments array excluded"
		);
	});

	it("includes non-empty attachments", () => {
		const attachments = [{ artifactId: "a1" }];
		const body = buildRunInputBody({ content: "test", attachments });
		assert.deepStrictEqual(body.attachments, attachments, "attachments included");
	});

	it("includes clientKey when provided", () => {
		const body = buildRunInputBody({
			content: "test",
			clientKey: "key-123",
		});
		assert.strictEqual(body.clientKey, "key-123", "clientKey included");
	});

	it("builds complete body with all fields", () => {
		const attachments = [{ artifactId: "img1" }];
		const body = buildRunInputBody({
			content: "do this",
			mode: "interrupt",
			attachments,
			clientKey: "k1",
		});
		assert.deepStrictEqual(
			body,
			{
				content: "do this",
				mode: "interrupt",
				attachments,
				clientKey: "k1",
			},
			"all fields included"
		);
	});
});

describe("createRunInput (production with mocked fetch)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("POSTs to /v1/runs/<id>/inputs with mode in body", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;

		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedInit = init;
			return new Response(
				JSON.stringify({
					input: {
						id: "i1",
						seq: 1,
						mode: "interrupt",
						status: "pending",
						content: "stop",
					},
				}),
				{ status: 201, headers: { "content-type": "application/json" } }
			);
		};

		const result = await createRunInput("run-xyz", {
			content: "redirect this",
			mode: "interrupt",
		});

		assert.ok(
			capturedUrl.includes("/v1/runs/run-xyz/inputs"),
			"endpoint is correct"
		);
		assert.strictEqual(capturedInit?.method, "POST", "method is POST");
		const bodyObj = JSON.parse(String(capturedInit?.body)) as Record<
			string,
			unknown
		>;
		assert.strictEqual(bodyObj.mode, "interrupt", "mode in POST body");
		assert.strictEqual(
			(result.input as Record<string, unknown>).mode,
			"interrupt",
			"response mode is interrupt"
		);
	});

	it("includes queue mode in the POST body", async () => {
		let capturedBody: Record<string, unknown> = {};

		globalThis.fetch = async (url, init) => {
			capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					input: {
						id: "i2",
						seq: 1,
						mode: "queue",
						status: "pending",
						content: "later",
					},
				}),
				{ status: 201 }
			);
		};

		await createRunInput("run-abc", {
			content: "send after",
			mode: "queue",
		});

		assert.strictEqual(
			capturedBody.mode,
			"queue",
			"queue mode in POST body"
		);
	});
});

describe("transcribeDictation", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => { globalThis.fetch = realFetch; });

	it("envia multipart com idioma e duração e devolve o texto", async () => {
		let seen: { url: string; body: FormData } | undefined;
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			seen = { url, body: init.body as FormData };
			return new Response(JSON.stringify({ text: "olá" }), { status: 200 });
		}) as unknown as typeof fetch;
		const { transcribeDictation } = await import("./atlas-api");
		const text = await transcribeDictation(new Blob([new Uint8Array(3)], { type: "audio/webm" }), { language: "pt-BR", durationMs: 1234.4 });
		assert.strictEqual(text, "olá");
		assert.match(seen!.url, /\/v1\/transcriptions$/);
		assert.strictEqual(seen!.body.get("language"), "pt-BR");
		assert.strictEqual(seen!.body.get("durationMs"), "1234");
		assert.ok(seen!.body.get("file") instanceof Blob);
	});

	it("erro da API vira AtlasApiError com a mensagem do servidor", async () => {
		globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Não consegui transcrever o áudio agora." }), { status: 502 })) as unknown as typeof fetch;
		const { transcribeDictation } = await import("./atlas-api");
		await assert.rejects(() => transcribeDictation(new Blob([new Uint8Array(1)]), {}), /Não consegui transcrever/);
	});

	it("502 do proxy (corpo não-JSON) tenta de novo e se recupera", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			return calls === 1 ? new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" }) : new Response(JSON.stringify({ text: "ok" }), { status: 200 });
		}) as unknown as typeof fetch;
		const { transcribeDictation } = await import("./atlas-api");
		assert.strictEqual(await transcribeDictation(new Blob([new Uint8Array(1)]), {}, undefined, { retryDelayMs: 0 }), "ok");
		assert.strictEqual(calls, 2);
	});

	it("502 persistente vira mensagem amigavel (nao 'Bad Gateway') apos 2 tentativas", async () => {
		let calls = 0;
		globalThis.fetch = (async () => { calls += 1; return new Response("<html>Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" }); }) as unknown as typeof fetch;
		const { transcribeDictation } = await import("./atlas-api");
		await assert.rejects(
			() => transcribeDictation(new Blob([new Uint8Array(1)]), {}, undefined, { retryDelayMs: 0 }),
			(error: Error) => /não respondeu a tempo/.test(error.message) && !/Bad Gateway/.test(error.message),
		);
		assert.strictEqual(calls, 2);
	});

	it("falha de rede tenta de novo; 503 da API nao repete", async () => {
		let calls = 0;
		globalThis.fetch = (async () => { calls += 1; if (calls === 1) throw new TypeError("Failed to fetch"); return new Response(JSON.stringify({ text: "x" }), { status: 200 }); }) as unknown as typeof fetch;
		const { transcribeDictation } = await import("./atlas-api");
		assert.strictEqual(await transcribeDictation(new Blob([new Uint8Array(1)]), {}, undefined, { retryDelayMs: 0 }), "x");
		calls = 0;
		globalThis.fetch = (async () => { calls += 1; return new Response(JSON.stringify({ error: "Transcrição indisponível" }), { status: 503 }); }) as unknown as typeof fetch;
		await assert.rejects(() => transcribeDictation(new Blob([new Uint8Array(1)]), {}, undefined, { retryDelayMs: 0 }), /indisponível/);
		assert.strictEqual(calls, 1);
	});

	it("mensagem do gateway por status", async () => {
		const { dictationGatewayMessage, isRetryableDictationStatus } = await import("./atlas-api");
		assert.match(dictationGatewayMessage(504), /demorou demais/);
		assert.match(dictationGatewayMessage(null), /Sem conexão/);
		assert.deepStrictEqual([500, 502, 503, 504, 413].map(isRetryableDictationStatus), [true, true, false, true, false]);
	});
});

describe("compactErrorText (/compact)", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	async function compactFailure(response: () => Response | Promise<Response>): Promise<unknown> {
		globalThis.fetch = (async () => response()) as unknown as typeof fetch;
		const { compactConversation } = await import("./atlas-api");
		return compactConversation("conv-1").then(
			() => assert.fail("deveria falhar"),
			(error: unknown) => error,
		);
	}

	it("502 do proxy com página HTML (sem statusText, como no HTTP/2): aviso amigável, nunca 'HTTP 502'", async () => {
		const { compactErrorText, COMPACT_FAILED_TEXT } = await import("./atlas-api");
		const error = await compactFailure(() => new Response("<html><title>502 Bad Gateway</title></html>", { status: 502 }));
		const text = compactErrorText(error);
		assert.strictEqual(text, COMPACT_FAILED_TEXT);
		assert.doesNotMatch(text, /HTTP|502|Bad Gateway/);
	});

	it("mensagem da API (falha do resumo 503, bloqueio 409) aparece como veio", async () => {
		const { compactErrorText } = await import("./atlas-api");
		const failed = await compactFailure(() => new Response(JSON.stringify({ error: "Não consegui resumir a conversa agora. Tente de novo em instantes." }), { status: 503 }));
		assert.strictEqual(compactErrorText(failed), "Não consegui resumir a conversa agora. Tente de novo em instantes.");
		const blocked = await compactFailure(() => new Response(JSON.stringify({ error: "Há uma execução em andamento.", reason: "run_active" }), { status: 409 }));
		assert.strictEqual(compactErrorText(blocked), "Há uma execução em andamento.");
	});

	it("queda de rede: aviso amigável", async () => {
		const { compactErrorText, COMPACT_FAILED_TEXT } = await import("./atlas-api");
		const error = await compactFailure(() => Promise.reject(new TypeError("Failed to fetch")));
		assert.strictEqual(compactErrorText(error), COMPACT_FAILED_TEXT);
	});
});
