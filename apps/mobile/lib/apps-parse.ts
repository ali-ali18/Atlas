// Aplicativos (conectores): parse defensivo das respostas de `/v1/mcp/*` e `/v1/composio/*`. O que o servidor devolve é
// dado não confiável: campo fora do formato é descartado, nunca desenhado. Funções puras, testadas em apps-parse.test.ts.
import { customMcpIconPath } from "@workspace/shared";


export type ConnectionStatus = "pending_auth" | "connected" | "error";

export type ConnectorSkill = { key: string; title: string; description: string };
/** Conector nativo do catálogo (`GET /v1/mcp/catalog`) com o estado da conexão do dono. */
export type NativeConnector = {
	id: string;
	name: string;
	description: string;
	longDescription: string;
	category: string;
	icon: string | null;
	authType: "oauth" | "api_key" | "none";
	comingSoon: boolean;
	apiKey: { label: string; helpUrl: string } | null;
	skills: ConnectorSkill[];
	oauthReady: boolean;
	connectionId: string | null;
	status: ConnectionStatus | null;
	accountCount: number;
};

/** Conexão do dono (`GET /v1/mcp/connections`). `catalogId` nulo = conector próprio (custom). */
export type McpConnection = { id: string; catalogId: string | null; name: string; authType: string; status: ConnectionStatus; accountLabel: string; icon: string | null };

export type ComposioToolkit = { slug: string; name: string; description: string; logo: string | null; connected: boolean; noAuth: boolean; nativeCatalogId: string | null };
export type ComposioPage = { items: ComposioToolkit[]; nextCursor: string | null; totalItems: number };
export type ComposioConnection = { id: string; toolkit: string; toolkitName: string; noAuth: boolean };
export type ComposioCategory = { id: string; name: string };

/** O que o servidor manda ao iniciar uma conexão: já conectou, abre o navegador ou (Composio sem login) só ativou. */
export type ConnectResult = { kind: "connected" } | { kind: "browser"; url: string; connectionId: string | null };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const statusOf = (value: unknown): ConnectionStatus | null => (value === "pending_auth" || value === "connected" || value === "error" ? value : null);

function parseSkills(value: unknown): ConnectorSkill[] {
	const skills: ConnectorSkill[] = [];
	for (const raw of Array.isArray(value) ? value : []) {
		if (!isRecord(raw)) continue;
		const title = text(raw.title);
		if (!title) continue;
		skills.push({ key: text(raw.key) || title, title, description: text(raw.description) });
	}
	return skills;
}

function parseNative(raw: unknown): NativeConnector | null {
	if (!isRecord(raw)) return null;
	const id = text(raw.id);
	const name = text(raw.name);
	if (!id || !name) return null;
	const authType = raw.authType === "api_key" || raw.authType === "none" ? raw.authType : "oauth";
	const apiKey = isRecord(raw.apiKey) ? { label: text(raw.apiKey.label) || "Chave de API", helpUrl: text(raw.apiKey.helpUrl) } : null;
	const accountCount = typeof raw.accountCount === "number" && Number.isFinite(raw.accountCount) ? Math.max(0, Math.floor(raw.accountCount)) : 0;
	return {
		id,
		name,
		description: text(raw.description),
		longDescription: text(raw.longDescription) || text(raw.description),
		category: text(raw.category) || "custom",
		icon: text(raw.icon) || null,
		authType,
		comingSoon: raw.availability === "coming_soon",
		apiKey,
		skills: parseSkills(raw.skills),
		oauthReady: raw.oauthReady === true,
		connectionId: text(raw.connectionId) || null,
		status: statusOf(raw.status),
		accountCount,
	};
}

/** `GET /v1/mcp/catalog`. Corpo que não é um catálogo dá `null`; entrada sem id ou nome é descartada. */
export function parseMcpCatalog(body: unknown): NativeConnector[] | null {
	if (!isRecord(body) || !Array.isArray(body.entries)) return null;
	const seen = new Set<string>();
	const entries: NativeConnector[] = [];
	for (const raw of body.entries) {
		const entry = parseNative(raw);
		if (!entry || seen.has(entry.id)) continue;
		seen.add(entry.id);
		entries.push(entry);
	}
	return entries;
}

/**
 * Logo de um conector que a pessoa adicionou: mesma regra do web (`custom-mcp-icon.tsx`, `customMcpHost` + `customMcpIconPath`
 * de `@workspace/shared`): o host da `url` da conexão vira `/v1/mcp/icon/<host>`, imagem que o servidor busca e valida.
 * URL que não é http(s) ou sem host público válido → `null` (fica a inicial).
 */
export function customMcpIcon(url: string): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
		const host = parsed.hostname.toLowerCase();
		return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? customMcpIconPath(host) : null;
	} catch {
		return null;
	}
}

function parseConnection(raw: unknown): McpConnection | null {
	if (!isRecord(raw)) return null;
	const id = text(raw.id);
	const status = statusOf(raw.status);
	if (!id || !status) return null;
	return { id, catalogId: text(raw.catalogId) || null, name: text(raw.name) || text(raw.slug) || "Conector", authType: text(raw.authType), status, accountLabel: text(raw.accountLabel), icon: customMcpIcon(text(raw.url)) };
}

/** `GET /v1/mcp/connections`. */
export function parseMcpConnections(body: unknown): McpConnection[] | null {
	if (!isRecord(body) || !Array.isArray(body.connections)) return null;
	return body.connections.map(parseConnection).filter((item): item is McpConnection => item !== null);
}

/** Só `https` (logo externo do Composio): outra coisa vira "sem logo", como no web (`composioLogoUrl`). */
export function safeLogoUrl(raw: unknown): string | null {
	try {
		const url = new URL(text(raw));
		return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}

function parseToolkit(raw: unknown): ComposioToolkit | null {
	if (!isRecord(raw)) return null;
	const slug = text(raw.slug);
	const name = text(raw.name);
	if (!slug || !name) return null;
	return { slug, name, description: text(raw.description), logo: safeLogoUrl(raw.logo), connected: raw.connected === true, noAuth: raw.noAuth === true, nativeCatalogId: text(raw.nativeCatalogId) || null };
}

/** `GET /v1/composio/toolkits`. */
export function parseComposioPage(body: unknown): ComposioPage | null {
	if (!isRecord(body) || !Array.isArray(body.items)) return null;
	const items = body.items.map(parseToolkit).filter((item): item is ComposioToolkit => item !== null);
	const total = typeof body.totalItems === "number" && Number.isFinite(body.totalItems) ? body.totalItems : items.length;
	return { items, nextCursor: text(body.nextCursor) || null, totalItems: total };
}

/** `GET /v1/composio/status`: `configured` só vale se for exatamente `true`. */
export function parseComposioConfigured(body: unknown): boolean {
	return isRecord(body) && body.configured === true;
}

/**
 * Teto de categorias do Composio no app. A API devolveu 63.508 categorias (muitas repetidas) mesmo com limit=100, e
 * cada uma virava um chip sem virtualização: a thread JS congelava e o app morria por memória. 15 (decisão do dono: 10 a 15, no máximo 15) cobre
 * a faixa de chips (que rola na horizontal) sem pesar a tela.
 */
export const MAX_COMPOSIO_CATEGORIES = 15;

/** Lê só até juntar `MAX_COMPOSIO_CATEGORIES` únicas (por id, na ordem): o custo não cresce com o tamanho da resposta. */
export function parseComposioCategories(body: unknown): ComposioCategory[] {
	if (!isRecord(body) || !Array.isArray(body.categories)) return [];
	const seen = new Set<string>();
	const out: ComposioCategory[] = [];
	for (const raw of body.categories) {
		if (out.length >= MAX_COMPOSIO_CATEGORIES) break;
		if (!isRecord(raw)) continue;
		const id = text(raw.id) || text(raw.slug);
		const name = text(raw.name);
		if (!id || !name || seen.has(id)) continue;
		seen.add(id);
		out.push({ id, name });
	}
	return out;
}

/** `GET /v1/composio/connections`. */
export function parseComposioConnections(body: unknown): ComposioConnection[] | null {
	if (!isRecord(body) || !Array.isArray(body.connections)) return null;
	const out: ComposioConnection[] = [];
	for (const raw of body.connections) {
		if (!isRecord(raw)) continue;
		const id = text(raw.id);
		const toolkit = text(raw.toolkit);
		if (!id || !toolkit) continue;
		out.push({ id, toolkit, toolkitName: text(raw.toolkitName) || toolkit, noAuth: raw.noAuth === true });
	}
	return out;
}

/** O servidor configurado é http (desenvolvimento local)? Só então o login pode abrir um endereço http. */
export function allowsHttp(serverUrl: string | null): boolean {
	return !!serverUrl && /^http:\/\//i.test(serverUrl.trim());
}

/** Só https abre no navegador (http só com servidor http, em desenvolvimento); qualquer outro esquema (javascript:, intent:) é descartado. */
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

/** O endereço a abrir: `handoffUrl` (novo, quando o servidor já manda), senão `authorizeUrl` (MCP) ou `redirectUrl` (Composio). */
export function pickBrowserUrl(body: Record<string, unknown>, allowHttp = false): string | null {
	return browserUrl(body.handoffUrl, allowHttp) ?? browserUrl(body.authorizeUrl, allowHttp) ?? browserUrl(body.redirectUrl, allowHttp);
}

/** Resposta de `POST /v1/mcp/connections` (e `/reauth`) ou `POST /v1/composio/connect`. */
export function parseConnectResult(body: unknown, allowHttp = false): ConnectResult | null {
	if (!isRecord(body)) return null;
	const url = pickBrowserUrl(body, allowHttp);
	if (url) return { kind: "browser", url, connectionId: isRecord(body.connection) ? text(body.connection.id) || null : null };
	// Sem endereço, só vale como conectado se o servidor disse isso; "pendente" sem link não tem como continuar.
	if ((isRecord(body.connection) && body.connection.status === "connected") || body.enabled === true) return { kind: "connected" };
	return null;
}
