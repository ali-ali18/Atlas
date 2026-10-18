import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { connectChatgptProvider, disconnectChatgptProvider, listChatgptModels, listProviders } from "./atlas-api";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
test("cliente tipado usa sessão same-origin e endpoints de provedor, sem credencial OAuth", async () => {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	globalThis.fetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		return new Response(JSON.stringify({ providers: [], models: [], status: "disconnected", catalogAvailable: false, ok: true, revocationConfirmed: false, authorizeUrl: "https://auth.openai.com/api/accounts/authorize" }));
	});
	await listProviders(); await connectChatgptProvider();
	assert.equal((await disconnectChatgptProvider()).revocationConfirmed, false);
	await listChatgptModels("chatgpt/luna");
	assert.deepEqual(calls.map(({ url }) => url), ["/v1/providers", "/v1/providers/chatgpt/connect", "/v1/providers/chatgpt", "/v1/providers/chatgpt/models?selected=chatgpt%2Fluna"]);
	assert.deepEqual(calls.map(({ init }) => init?.credentials), Array(4).fill("same-origin"));
	assert.deepEqual(calls.map(({ init }) => init?.method), [undefined, "POST", "DELETE", undefined]);
	assert.ok(calls.every(({ init }) => !JSON.stringify(init).includes("Bearer")));
});

test("SSE encaminha fallback de provedor sem confundir com falha do run", async () => {
 const { runComputerUse } = await import("./atlas-api");
 const event = { type: "provider_fallback", from: "chatgpt/luna", to: "deepseek/deepseek-v4.1-flash", reason: "limit", message: "Cota do plano atingida; seguindo pelo fallback." };
 globalThis.fetch = mock.fn(async () => new Response(`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify({ type: "status", status: "running" })}\n\n`, { headers: { "Content-Type": "text/event-stream" } }));
 const received: unknown[] = []; const statuses: string[] = [];
 await runComputerUse({ messages: [], model: "chatgpt/luna" }, { onDelta: () => {}, onProviderFallback: (value) => received.push(value), onStatus: (value) => statuses.push(value), onError: () => assert.fail("fallback não encerra o run") });
 assert.deepEqual(received, [event]); assert.deepEqual(statuses, ["running"]);
});

test("SSE done conserva usage medido para footer do plano", async () => {
 const { runComputerUse } = await import("./atlas-api");
 const usage = { promptTokens: 4, completionTokens: 2, totalTokens: 6, planCalls: 1 };
 const event = { type: "done", message: { role: "assistant", content: "Feito" }, model: "chatgpt/luna", usage };
 globalThis.fetch = mock.fn(async () => new Response(`data: ${JSON.stringify(event)}\n\n`));
 let received: unknown;
 await runComputerUse({ messages: [] }, { onDelta: () => {}, onDone: (result) => { received = result.usage; } });
 assert.deepEqual(received, usage);
});

test("PATCH de configurações recusado traz a mensagem do campo, não só 'Configuração inválida'", async () => {
	const { patchAccountSettings, AtlasApiError } = await import("./atlas-api");
	const message = "Ative o plano ChatGPT em Configurações → Provedores para usar este modelo";
	globalThis.fetch = mock.fn(async () =>
		new Response(JSON.stringify({ error: "Configuração inválida", fields: [{ path: "models.default", message }] }), { status: 400 }),
	);
	await assert.rejects(
		patchAccountSettings({ config: { models: { default: "chatgpt/gpt-5" } } }),
		(error) => error instanceof AtlasApiError && error.status === 400 && error.message === message,
	);
	globalThis.fetch = mock.fn(async () => new Response(JSON.stringify({ error: "Não encontrado" }), { status: 404 }));
	await assert.rejects(patchAccountSettings({ config: {} }), (error) => error instanceof AtlasApiError && error.message === "Não encontrado");
});

test("login por código usa POST same-origin em device/start e device/poll", async () => {
	const { startChatgptDeviceLogin, pollChatgptDeviceLogin } = await import("./atlas-api");
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	globalThis.fetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		return new Response(JSON.stringify({ status: "pending", intervalSeconds: 5 }));
	});
	await startChatgptDeviceLogin(); await pollChatgptDeviceLogin();
	assert.deepEqual(calls.map(({ url }) => url), ["/v1/providers/chatgpt/device/start", "/v1/providers/chatgpt/device/poll"]);
	assert.deepEqual(calls.map(({ init }) => init?.method), ["POST", "POST"]);
	assert.deepEqual(calls.map(({ init }) => init?.credentials), ["same-origin", "same-origin"]);
});
