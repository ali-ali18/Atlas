// Conectar o app do cartão "conectar app" pelo navegador. Módulo enxuto: DUPLICA, de `feat/mobile-aplicativos`
// (`apps-parse.ts` e `apps-api.ts`), só o que o cartão usa (resultado da conexão, "já está conectado?"). Quando as duas
// branches entrarem na main, apague este arquivo e importe de lá. O contrato é o do web: `POST /v1/mcp/connections`
// (nativo), `POST /v1/composio/connect` (Composio), ambos com `client: "mobile"` (o servidor devolve o `handoffUrl`).
import type { LoginConnector } from "@workspace/shared";
import { ChatApiError, json } from "./chat-api";
import type { ApiFetch } from "./home-sync";

/** O que o servidor manda ao iniciar a conexão: já conectou, ou o endereço do login para abrir no navegador. */
export type ConnectResult = { kind: "connected" } | { kind: "browser"; url: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** O servidor configurado é http (desenvolvimento local)? Só então o login pode abrir um endereço http. */
export function allowsHttp(serverUrl: string | null): boolean {
	return !!serverUrl && /^http:\/\//i.test(serverUrl.trim());
}

/** Só https abre no navegador (http só com servidor http); qualquer outro esquema (javascript:, intent:) é descartado. */
export function browserUrl(raw: unknown, allowHttp = false): string | null {
	const value = text(raw);
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || (allowHttp && url.protocol === "http:") ? url.href : null;
	} catch {
		return null;
	}
}

/** `handoffUrl` (o servidor já manda o retorno ao app), senão `authorizeUrl` (MCP) ou `redirectUrl` (Composio). */
export function pickBrowserUrl(body: Record<string, unknown>, allowHttp = false): string | null {
	return browserUrl(body.handoffUrl, allowHttp) ?? browserUrl(body.authorizeUrl, allowHttp) ?? browserUrl(body.redirectUrl, allowHttp);
}

export function parseConnectResult(body: unknown, allowHttp = false): ConnectResult | null {
	if (!isRecord(body)) return null;
	const url = pickBrowserUrl(body, allowHttp);
	if (url) return { kind: "browser", url };
	// Sem endereço, só vale como conectado se o servidor disse isso.
	if ((isRecord(body.connection) && body.connection.status === "connected") || body.enabled === true) return { kind: "connected" };
	return null;
}

type McpConnection = { id: string; catalogId: string | null; status: string };

/** `GET /v1/mcp/connections`: só o que a conferência usa. */
export function parseMcpConnections(body: unknown): McpConnection[] | null {
	if (!isRecord(body) || !Array.isArray(body.connections)) return null;
	const out: McpConnection[] = [];
	for (const raw of body.connections) {
		if (!isRecord(raw)) continue;
		const id = text(raw.id);
		if (id) out.push({ id, catalogId: text(raw.catalogId) || null, status: text(raw.status) });
	}
	return out;
}

/** `GET /v1/composio/connections`: os slugs dos toolkits conectados. */
export function parseComposioToolkits(body: unknown): string[] | null {
	if (!isRecord(body) || !Array.isArray(body.connections)) return null;
	return body.connections.flatMap((raw) => (isRecord(raw) && text(raw.toolkit) ? [text(raw.toolkit)] : []));
}

const unexpected = () => new ChatApiError("Resposta inesperada do servidor.", 502);

/** A conexão do conector do cartão já está ativa no servidor? (a conferência do polling) */
export async function isConnectorConnected(apiFetch: ApiFetch, connector: LoginConnector): Promise<boolean> {
	if (connector.kind === "composio") {
		const toolkits = parseComposioToolkits(await json<unknown>(apiFetch, "/v1/composio/connections"));
		if (!toolkits) throw unexpected();
		return toolkits.includes(connector.id);
	}
	const connections = parseMcpConnections(await json<unknown>(apiFetch, "/v1/mcp/connections"));
	if (!connections) throw unexpected();
	return connections.some((item) => item.catalogId === connector.id && item.status === "connected");
}

/** Inicia a conexão. Nativo que perdeu o login (`reconnect`) usa o `reauth` da conexão que já existe. */
export async function startConnectorConnect(apiFetch: ApiFetch, connector: LoginConnector, allowHttp = false): Promise<ConnectResult> {
	if (connector.kind === "composio") {
		const result = parseConnectResult(await json<unknown>(apiFetch, "/v1/composio/connect", { method: "POST", body: JSON.stringify({ toolkit: connector.id, client: "mobile" }) }), allowHttp);
		if (!result) throw unexpected();
		return result;
	}
	if (connector.reconnect) {
		const existing = parseMcpConnections(await json<unknown>(apiFetch, "/v1/mcp/connections"))?.find((item) => item.catalogId === connector.id);
		if (existing) {
			const result = parseConnectResult(await json<unknown>(apiFetch, `/v1/mcp/connections/${encodeURIComponent(existing.id)}/reauth`, { method: "POST", body: JSON.stringify({ client: "mobile" }) }), allowHttp);
			if (!result) throw unexpected();
			return result;
		}
	}
	const result = parseConnectResult(await json<unknown>(apiFetch, "/v1/mcp/connections", { method: "POST", body: JSON.stringify({ catalogId: connector.id, client: "mobile" }) }), allowHttp);
	if (!result) throw unexpected();
	return result;
}

/** Frase simples para a falha de conectar (sem texto técnico nem o texto cru do servidor). */
export function connectErrorText(error: unknown): string {
	if (error instanceof ChatApiError) {
		if (error.status === 401) return "Sua sessão expirou. Entre de novo.";
		if (error.status === 400 || error.status === 404) return "Não consegui conectar este aplicativo. Tente de novo.";
		if (error.status === 409) return "Ative os apps nas Configurações do site.";
		if (error.status === 503) return "O servidor não consegue conectar aplicativos agora.";
		return "Não consegui conectar agora. Tente de novo.";
	}
	return "Sem conexão com o seu servidor. Tente de novo.";
}
