import { describe, expect, it } from "vitest";
import { ChatApiError } from "./chat-api";
import { allowsHttp, browserUrl, connectErrorText, isConnectorConnected, parseComposioToolkits, parseConnectResult, parseMcpConnections, pickBrowserUrl, startConnectorConnect } from "./connector-connect";
import type { ApiFetch } from "./home-sync";

const native = { kind: "native", id: "github", name: "GitHub", description: "", icon: null } as const;
const composio = { kind: "composio", id: "gmail", name: "Gmail", description: "", icon: null } as const;

function server(routes: Record<string, unknown>) {
	const calls: Array<{ path: string; method?: string; body: unknown }> = [];
	const apiFetch: ApiFetch = async (path, init) => {
		calls.push({ path, method: init?.method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
		const key = `${init?.method ?? "GET"} ${path}`;
		if (!(key in routes)) return new Response("{}", { status: 404 });
		return new Response(JSON.stringify(routes[key]), { status: 200 });
	};
	return { apiFetch, calls };
}

describe("endereço do navegador", () => {
	it("só https (http só com servidor http); outros esquemas são descartados", () => {
		expect(browserUrl("https://a.example/x")).toBe("https://a.example/x");
		expect(browserUrl("http://a.example")).toBeNull();
		expect(browserUrl("http://a.example", true)).toBe("http://a.example/");
		expect(browserUrl("javascript:alert(1)", true)).toBeNull();
		expect(allowsHttp("http://localhost:3000")).toBe(true);
		expect(allowsHttp("https://x")).toBe(false);
	});
	it("handoffUrl vale antes de authorizeUrl e redirectUrl", () => {
		expect(pickBrowserUrl({ handoffUrl: "https://h", authorizeUrl: "https://a", redirectUrl: "https://r" })).toBe("https://h/");
		expect(pickBrowserUrl({ authorizeUrl: "https://a" })).toBe("https://a/");
		expect(pickBrowserUrl({ redirectUrl: "https://r" })).toBe("https://r/");
	});
	it("resultado: endereço abre o navegador; conectado/ativado conecta; o resto é inválido", () => {
		expect(parseConnectResult({ authorizeUrl: "https://a" })).toEqual({ kind: "browser", url: "https://a/" });
		expect(parseConnectResult({ connection: { status: "connected" } })).toEqual({ kind: "connected" });
		expect(parseConnectResult({ enabled: true })).toEqual({ kind: "connected" });
		expect(parseConnectResult({ connection: { status: "pending_auth" } })).toBeNull();
		expect(parseConnectResult("x")).toBeNull();
	});
});

describe("conexão: início e conferência", () => {
	it("nativo: POST /v1/mcp/connections com o catálogo e client mobile", async () => {
		const { apiFetch, calls } = server({ "POST /v1/mcp/connections": { handoffUrl: "https://login.example/go" } });
		expect(await startConnectorConnect(apiFetch, native)).toEqual({ kind: "browser", url: "https://login.example/go" });
		expect(calls[0]).toEqual({ path: "/v1/mcp/connections", method: "POST", body: { catalogId: "github", client: "mobile" } });
	});
	it("nativo que perdeu o login usa o reauth da conexão que já existe", async () => {
		const { apiFetch, calls } = server({
			"GET /v1/mcp/connections": { connections: [{ id: "cn 1", catalogId: "github", status: "error" }] },
			"POST /v1/mcp/connections/cn%201/reauth": { authorizeUrl: "https://login.example/re" },
		});
		expect(await startConnectorConnect(apiFetch, { ...native, reconnect: true })).toEqual({ kind: "browser", url: "https://login.example/re" });
		expect(calls[1]).toEqual({ path: "/v1/mcp/connections/cn%201/reauth", method: "POST", body: { client: "mobile" } });
	});
	it("Composio: POST /v1/composio/connect com o slug e client mobile", async () => {
		const { apiFetch, calls } = server({ "POST /v1/composio/connect": { redirectUrl: "https://c.example/auth" } });
		expect(await startConnectorConnect(apiFetch, composio)).toEqual({ kind: "browser", url: "https://c.example/auth" });
		expect(calls[0]).toEqual({ path: "/v1/composio/connect", method: "POST", body: { toolkit: "gmail", client: "mobile" } });
	});
	it("resposta sem endereço nem conexão falha (não finge)", async () => {
		const { apiFetch } = server({ "POST /v1/composio/connect": { connection: { status: "pending_auth" } } });
		await expect(startConnectorConnect(apiFetch, composio)).rejects.toBeInstanceOf(ChatApiError);
	});
	it("conferência: nativo só conta conexão ativa do mesmo catálogo; Composio pelo slug", async () => {
		const mcp = { connections: [{ id: "1", catalogId: "github", status: "pending_auth" }, { id: "2", catalogId: "slack", status: "connected" }] };
		expect(await isConnectorConnected(server({ "GET /v1/mcp/connections": mcp }).apiFetch, native)).toBe(false);
		expect(await isConnectorConnected(server({ "GET /v1/mcp/connections": { connections: [{ id: "1", catalogId: "github", status: "connected" }] } }).apiFetch, native)).toBe(true);
		expect(await isConnectorConnected(server({ "GET /v1/composio/connections": { connections: [{ id: "a", toolkit: "gmail" }] } }).apiFetch, composio)).toBe(true);
		expect(await isConnectorConnected(server({ "GET /v1/composio/connections": { connections: [] } }).apiFetch, composio)).toBe(false);
	});
	it("parse defensivo das listas", () => {
		expect(parseMcpConnections({ nada: 1 })).toBeNull();
		expect(parseMcpConnections({ connections: [null, { id: "" }, { id: "x", status: "connected" }] })).toEqual([{ id: "x", catalogId: null, status: "connected" }]);
		expect(parseComposioToolkits({ connections: [{ toolkit: "a" }, { toolkit: "" }, 1] })).toEqual(["a"]);
	});
	it("erros em palavras simples", () => {
		expect(connectErrorText(new ChatApiError("x", 401))).toMatch(/sessão expirou/);
		expect(connectErrorText(new ChatApiError("x", 409))).toMatch(/Ative os apps/);
		expect(connectErrorText(new ChatApiError("raw 500", 500))).not.toMatch(/raw|500/);
		expect(connectErrorText(new Error("rede"))).toMatch(/conexão/);
	});
});
