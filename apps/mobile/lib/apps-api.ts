// Aplicativos no servidor: os mesmos endpoints do web (`/v1/mcp/*`, `/v1/composio/*`), sempre por `apiFetch` (cookie de
// sessão). O servidor decide o dono pela sessão; o app só manda ids. Parse em `apps-parse.ts`.
import { type ComposioCategory, type ComposioConnection, type ComposioPage, type ConnectResult, type McpConnection, type NativeConnector, parseComposioCategories, parseComposioConfigured, parseComposioConnections, parseComposioPage, parseConnectResult, parseMcpCatalog, parseMcpConnections } from "./apps-parse";
import { ChatApiError, isUnauthorized, json } from "./chat-api";
import type { ApiFetch } from "./home-sync";

const unexpected = () => new ChatApiError("Resposta inesperada do servidor.", 502);

export async function fetchMcpCatalog(apiFetch: ApiFetch): Promise<NativeConnector[]> {
	const entries = parseMcpCatalog(await json<unknown>(apiFetch, "/v1/mcp/catalog"));
	if (!entries) throw unexpected();
	return entries;
}

export async function fetchMcpConnections(apiFetch: ApiFetch): Promise<McpConnection[]> {
	const connections = parseMcpConnections(await json<unknown>(apiFetch, "/v1/mcp/connections"));
	if (!connections) throw unexpected();
	return connections;
}

/** O Composio está ativo para este dono? `409` (sem chave) e qualquer falha de leitura dão `false`; só 401 sobe. */
export async function fetchComposioConfigured(apiFetch: ApiFetch): Promise<boolean> {
	try {
		return parseComposioConfigured(await json<unknown>(apiFetch, "/v1/composio/status"));
	} catch (error) {
		if (isUnauthorized(error)) throw error;
		return false;
	}
}

export type ComposioQuery = { search?: string; cursor?: string | null; category?: string | null; limit?: number };

/** Pedido da lista do Composio (falha 409 = sem chave: quem chama trata como "desligado"). */
export async function fetchComposioToolkits(apiFetch: ApiFetch, query: ComposioQuery = {}): Promise<ComposioPage> {
	const params = new URLSearchParams();
	if (query.search?.trim()) params.set("search", query.search.trim());
	if (query.cursor) params.set("cursor", query.cursor);
	if (query.category) params.set("category", query.category);
	params.set("limit", String(query.limit ?? 20));
	const page = parseComposioPage(await json<unknown>(apiFetch, `/v1/composio/toolkits?${params.toString()}`));
	if (!page) throw unexpected();
	return page;
}

/** Categorias do Composio; é enfeite, então qualquer falha dá lista vazia. */
export async function fetchComposioCategories(apiFetch: ApiFetch): Promise<ComposioCategory[]> {
	try {
		return parseComposioCategories(await json<unknown>(apiFetch, "/v1/composio/categories"));
	} catch (error) {
		if (isUnauthorized(error)) throw error;
		return [];
	}
}

export async function fetchComposioConnections(apiFetch: ApiFetch): Promise<ComposioConnection[]> {
	const connections = parseComposioConnections(await json<unknown>(apiFetch, "/v1/composio/connections"));
	if (!connections) throw unexpected();
	return connections;
}

/** `POST /v1/mcp/connections`: OAuth devolve o endereço do login; chave conecta na hora. `client: "mobile"` faz o servidor mandar o retorno de volta ao app. */
export async function connectNative(apiFetch: ApiFetch, catalogId: string, apiKey?: string): Promise<ConnectResult> {
	const body = { catalogId, client: "mobile", ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}) };
	const result = parseConnectResult(await json<unknown>(apiFetch, "/v1/mcp/connections", { method: "POST", body: JSON.stringify(body) }));
	if (!result) throw unexpected();
	return result;
}

export async function reauthNative(apiFetch: ApiFetch, connectionId: string): Promise<ConnectResult> {
	const result = parseConnectResult(await json<unknown>(apiFetch, `/v1/mcp/connections/${encodeURIComponent(connectionId)}/reauth`, { method: "POST", body: JSON.stringify({ client: "mobile" }) }));
	if (!result) throw unexpected();
	return result;
}

export async function disconnectNative(apiFetch: ApiFetch, connectionId: string): Promise<void> {
	await request(apiFetch, `/v1/mcp/connections/${encodeURIComponent(connectionId)}`);
}

export async function connectComposio(apiFetch: ApiFetch, toolkit: string): Promise<ConnectResult> {
	const result = parseConnectResult(await json<unknown>(apiFetch, "/v1/composio/connect", { method: "POST", body: JSON.stringify({ toolkit, client: "mobile" }) }));
	if (!result) throw unexpected();
	return result;
}

export async function disconnectComposio(apiFetch: ApiFetch, connectionId: string): Promise<void> {
	await request(apiFetch, `/v1/composio/connections/${encodeURIComponent(connectionId)}`);
}

/** DELETE sem corpo de volta (204). */
async function request(apiFetch: ApiFetch, path: string): Promise<void> {
	const response = await apiFetch(path, { method: "DELETE" });
	if (!response.ok) throw new ChatApiError(response.statusText || `HTTP ${response.status}`, response.status);
}

export type AppsAction = "list" | "connect" | "disconnect";

/** Frase simples para o erro (sem texto técnico nem o texto cru do servidor). */
export function appsErrorText(error: unknown, action: AppsAction): string {
	if (error instanceof ChatApiError) {
		if (isUnauthorized(error)) return "Sua sessão expirou. Entre de novo.";
		if (action === "connect") {
			if (error.status === 400 || error.status === 404) return "Não consegui conectar este aplicativo. Confira os dados e tente de novo.";
			if (error.status === 409) return "Ative os apps nas Configurações do site.";
			if (error.status === 503) return "O servidor não consegue conectar aplicativos agora.";
			return "Não consegui conectar agora. Tente de novo.";
		}
		if (action === "disconnect") return "Não consegui desconectar agora. Tente de novo.";
		return "Não consegui carregar os aplicativos agora. Tente de novo em instantes.";
	}
	return "Sem conexão com o seu servidor. Tente de novo.";
}
