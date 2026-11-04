// Aplicativos no servidor: os mesmos endpoints do web (`/v1/mcp/*`, `/v1/composio/*`), sempre por `apiFetch` (cookie de
// sessão). O servidor decide o dono pela sessão; o app só manda ids. Parse em `apps-parse.ts`.
import {
	type ComposioCategory,
	type ComposioConnection,
	type ComposioPage,
	type ConnectResult,
	type McpConnection,
	type NativeConnector,
	parseComposioCategories,
	parseComposioConfigured,
	parseComposioConnections,
	parseComposioPage,
	parseConnectResult,
	parseMcpCatalog,
	parseMcpConnections,
} from "./apps-parse";
import { log } from "./apps-diagnostics";
import { ChatApiError, failure, isUnauthorized } from "./chat-api";
import type { ApiFetch } from "./home-sync";

/**
 * DIAGNÓSTICO: igual a `json()` (mesmo pedido e mesmos cabeçalhos), mas lê o texto cru antes do JSON para registrar o tamanho
 * da resposta em caracteres, a duração da leitura e a do parse. Mesmo resultado e mesmos erros de `json()`.
 */
async function json<T>(apiFetch: ApiFetch, path: string, init: RequestInit = {}): Promise<T> {
	const stage = path.split("?")[0]!.replace(/^\/v1\//, "");
	const from = Date.now();
	log(`${stage}:pedido`);
	const response = await apiFetch(path, {
		...init,
		headers: {
			accept: "application/json",
			...(init.body ? { "content-type": "application/json" } : {}),
			...(init.headers as Record<string, string> | undefined),
		},
	});
	if (!response.ok) {
		log(`${stage}:http`, { status: response.status, dur: Date.now() - from });
		return failure(response);
	}
	const raw = await response.text();
	const read = Date.now();
	log(`${stage}:texto`, { chars: raw.length, dur: read - from });
	const value = JSON.parse(raw) as T;
	log(`${stage}:json`, { dur: Date.now() - read });
	return value;
}

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

/** O Composio está ativo para este dono? Falha de leitura (500, rede) SOBE: não é o mesmo que "não configurado". */
export async function fetchComposioConfigured(apiFetch: ApiFetch): Promise<boolean> {
	return parseComposioConfigured(await json<unknown>(apiFetch, "/v1/composio/status"));
}

export type ComposioQuery = {
	search?: string;
	cursor?: string | null;
	category?: string | null;
	limit?: number;
};

/** Pedido da lista do Composio (falha 409 = sem chave: quem chama trata como "desligado"). */
export async function fetchComposioToolkits(apiFetch: ApiFetch, query: ComposioQuery = {}): Promise<ComposioPage> {
	const params = new URLSearchParams();
	if (query.search?.trim()) params.set("search", query.search.trim());
	if (query.cursor) params.set("cursor", query.cursor);
	if (query.category) params.set("category", query.category);
	params.set("limit", String(query.limit ?? 20));
	const body = await json<unknown>(apiFetch, `/v1/composio/toolkits?${params.toString()}`);
	const from = Date.now();
	const rawItems = typeof body === "object" && body !== null && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items.length : -1;
	log("toolkits:parse-início", {
		itensCrus: rawItems,
		limitePedido: query.limit ?? 20,
		cursor: query.cursor ? 1 : 0,
	});
	const page = parseComposioPage(body);
	log("toolkits:parse-fim", {
		itens: page?.items.length ?? -1,
		total: page?.totalItems ?? -1,
		proximo: page?.nextCursor ? page.nextCursor.length : 0,
		dur: Date.now() - from,
	});
	if (!page) throw unexpected();
	return page;
}

/** Categorias do Composio; é enfeite, então qualquer falha dá lista vazia. */
export async function fetchComposioCategories(apiFetch: ApiFetch): Promise<ComposioCategory[]> {
	try {
		const categories = parseComposioCategories(await json<unknown>(apiFetch, "/v1/composio/categories"));
		log("categorias:parse", { categorias: categories.length });
		return categories;
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
export async function connectNative(apiFetch: ApiFetch, catalogId: string, apiKey?: string, allowHttp = false): Promise<ConnectResult> {
	const body = {
		catalogId,
		client: "mobile",
		...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}),
	};
	const result = parseConnectResult(
		await json<unknown>(apiFetch, "/v1/mcp/connections", {
			method: "POST",
			body: JSON.stringify(body),
		}),
		allowHttp,
	);
	if (!result) throw unexpected();
	return result;
}

export async function reauthNative(apiFetch: ApiFetch, connectionId: string, allowHttp = false): Promise<ConnectResult> {
	const result = parseConnectResult(await json<unknown>(apiFetch, `/v1/mcp/connections/${encodeURIComponent(connectionId)}/reauth`, { method: "POST", body: JSON.stringify({ client: "mobile" }) }), allowHttp);
	if (!result) throw unexpected();
	return result;
}

export async function disconnectNative(apiFetch: ApiFetch, connectionId: string): Promise<void> {
	await request(apiFetch, `/v1/mcp/connections/${encodeURIComponent(connectionId)}`);
}

export async function connectComposio(apiFetch: ApiFetch, toolkit: string, allowHttp = false): Promise<ConnectResult> {
	const result = parseConnectResult(
		await json<unknown>(apiFetch, "/v1/composio/connect", {
			method: "POST",
			body: JSON.stringify({ toolkit, client: "mobile" }),
		}),
		allowHttp,
	);
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
