import assert from "node:assert/strict";
import test from "node:test";
import {
	navigateProviderPopup,
	parseProviderCallbackParams,
	PROVIDER_CONNECTED_MESSAGE,
	PROVIDER_RETRY_MESSAGE,
	providerCallbackStatus,
	providerMessageKind,
} from "./provider-connect";
test("login move popup já aberto para authorizeUrl oficial, sem conter tokens", async () => {
	const popup = { closed: false, location: { href: "about:blank", search: "" }, close() {} };
	await navigateProviderPopup(popup, async () => ({ authorizeUrl: "https://auth.openai.com/api/accounts/authorize?state=fixture" }));
	assert.equal(new URL(popup.location.href).origin, "https://auth.openai.com");
	assert.equal(providerCallbackStatus("?provider=chatgpt&status=ok"), "ok");
	assert.equal(providerCallbackStatus("?provider=chatgpt&status=error"), "error");
	assert.equal(providerCallbackStatus("?provider=other&status=ok"), null);
});
test("popup bloqueado, URL externa e falha de API não deixam janela enganosa", async () => {
	await assert.rejects(navigateProviderPopup(null, async () => ({ authorizeUrl: "https://auth.openai.com" })), /Permita popups/);
	for (const url of ["https://example.com/login", "javascript:alert(1)"]) {
		let closed = false;
		await assert.rejects(navigateProviderPopup({ closed: false, location: { href: "about:blank", search: "" }, close() { closed = true; } }, async () => ({ authorizeUrl: url })), /iniciar o login/);
		assert.equal(closed, true);
	}
});
test("retorno só vale na página de conexão (ou home antiga), com código seguro", () => {
	assert.equal(providerCallbackStatus("?provider=chatgpt&status=ok", "/providers/callback"), "ok");
	assert.equal(providerCallbackStatus("?provider=chatgpt&status=error", "/"), "error");
	assert.equal(providerCallbackStatus("?provider=chatgpt&status=ok", "/outra"), null);
	assert.deepEqual(parseProviderCallbackParams({ provider: "chatgpt", status: "ok" }), { status: "ok", code: null });
	assert.deepEqual(
		parseProviderCallbackParams({ provider: "chatgpt", status: "error", code: "invalid_token_response:scope" }),
		{ status: "error", code: "invalid_token_response:scope" },
	);
	for (const code of ["Bearer abc.def", "a".repeat(80), "x:y:z", ["a", "b"]])
		assert.equal(parseProviderCallbackParams({ provider: "chatgpt", status: "error", code }).code, null);
	assert.equal(parseProviderCallbackParams({}).status, "error");
	assert.equal(parseProviderCallbackParams({ provider: "x", status: "ok" }).status, "error");
});
test("postMessage: confere origem, popup e tipo", () => {
	const origin = "http://localhost:3000";
	const popup = {};
	const msg = (type: string, over: Record<string, unknown> = {}) => ({ origin, source: popup, data: { type, provider: "chatgpt", ...over } });
	assert.equal(providerMessageKind(msg(PROVIDER_CONNECTED_MESSAGE), origin, popup), "connected");
	assert.equal(providerMessageKind(msg(PROVIDER_RETRY_MESSAGE), origin, popup), "retry");
	assert.equal(providerMessageKind({ ...msg(PROVIDER_CONNECTED_MESSAGE), origin: "https://evil.example" }, origin, popup), null);
	assert.equal(providerMessageKind({ ...msg(PROVIDER_CONNECTED_MESSAGE), source: {} }, origin, popup), null);
	assert.equal(providerMessageKind(msg(PROVIDER_CONNECTED_MESSAGE, { provider: "outro" }), origin, popup), null);
	assert.equal(providerMessageKind(msg("atlas:mcp-oauth"), origin, popup), null);
	assert.equal(providerMessageKind({ origin, data: null }, origin), null);
	assert.equal(providerMessageKind({ origin, data: "texto" }, origin), null);
});
