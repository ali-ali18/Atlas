import type { ApiProposal } from "./api-connector.js";
import { parseApiProposal } from "./api-proposal.js";
import { nativeCatalogIdForToolkit, parseComposioToolkitSlug } from "./composio.js";
import { MCP_CATALOG, type McpCatalogEntry } from "./mcp-catalog.js";

/**
 * Dados de exibição do card "conecte este app" (ícone, nome, descrição curta).
 * Nunca carrega segredo: o clique no card dispara o fluxo de conexão normal.
 */
export type LoginConnector = {
	/** `native` = conector do Marketplace (OAuth próprio); `composio` = app via Composio; `custom` = servidor MCP remoto informado pelo usuário/agente. */
	kind: "native" | "composio" | "custom" | "api";
	/** `catalogId` (native), slug do toolkit (composio) ou slug do host (custom). */
	id: string;
	name: string;
	description: string;
	/** Caminho do ícone do catálogo (`/connectors/x.svg`) ou logo HTTPS do Composio. */
	icon: string | null;
	/** O conector já existe mas perdeu o login (expirado, erro ou pendente). */
	reconnect?: boolean;
	/** App do Composio sem login: o botão do card só ativa, sem popup. */
	noAuth?: boolean;
	/** `custom`: URL HTTPS do servidor MCP (o dialog "MCP personalizado" abre preenchido com ela). */
	url?: string;
	/** `custom`: como o servidor autentica (define o preenchimento do dialog). */
	auth?: CustomMcpAuth;
	/** `api`: proposta de conexão de API (resumo da especificação; o card pede as credenciais, nunca o modelo). */
	api?: ApiProposal;
};

export type CustomMcpAuth = "oauth" | "apiKey" | "none";

const CUSTOM_AUTHS: readonly CustomMcpAuth[] = ["oauth", "apiKey", "none"];

/** Caminho do ícone do servidor (proxy da API, sem o navegador falar com o site). */
export function customMcpIconPath(hostname: string): string {
	return `/v1/mcp/icon/${hostname.toLowerCase()}`;
}

const PRIVATE_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".intranet"];

/** Host que nunca é um servidor MCP público: localhost, nome interno, IP literal privado/loopback/link-local. */
export function isPrivateMcpHostname(rawHost: string): boolean {
	const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (!host) return true;
	if (host === "localhost" || PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
	if (host.includes(":")) {
		return host === "::" || host === "::1" || /^(fc|fd|fe[89ab])/.test(host) || host.startsWith("::ffff:");
	}
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
	}
	// Sem ponto = nome de rede interna; hosts numéricos soltos (ex.: 2130706433) também.
	return !host.includes(".") || /^\d+$/.test(host);
}

export type CustomMcpUrlResult = { ok: true; url: URL } | { ok: false; error: string };

/**
 * Mesmas regras do dialog "MCP personalizado" (HTTPS, sem credenciais/parâmetros;
 * HTTP só em localhost) mais o bloqueio de hosts privados. `allowLocal` só em dev.
 */
export function parseCustomMcpUrl(raw: unknown, options: { allowLocal?: boolean } = {}): CustomMcpUrlResult {
	if (typeof raw !== "string") return { ok: false, error: "URL inválida" };
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return { ok: false, error: "URL inválida" };
	}
	const local = options.allowLocal === true && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
	if (!local) {
		if (url.protocol !== "https:") return { ok: false, error: "Use uma URL HTTPS" };
		if (isPrivateMcpHostname(url.hostname)) return { ok: false, error: "A URL aponta para um endereço interno ou privado" };
	} else if (url.protocol !== "https:" && url.protocol !== "http:") {
		return { ok: false, error: "URL inválida" };
	}
	if (url.username || url.password || url.search || url.hash) {
		return { ok: false, error: "Use uma URL sem credenciais ou parâmetros" };
	}
	return { ok: true, url };
}

const NAME_MAX = 80;
const DESCRIPTION_MAX = 240;
const ICON_MAX = 500;

function parseIcon(raw: unknown): string | null {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > ICON_MAX) return null;
	if (/^\/(?!\/)[A-Za-z0-9._\-/]+$/.test(raw) && !raw.includes("..")) return raw;
	try {
		const url = new URL(raw);
		return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}

/** Valida o que vem de checkpoint, banco ou SSE: nunca confiar no formato. */
export function parseLoginConnector(raw: unknown): LoginConnector | null {
	if (!raw || typeof raw !== "object") return null;
	const row = raw as Record<string, unknown>;
	if (row.kind !== "native" && row.kind !== "composio" && row.kind !== "custom" && row.kind !== "api") return null;
	const id = parseComposioToolkitSlug(row.id);
	if (!id) return null;
	if (typeof row.name !== "string") return null;
	const name = row.name.trim().slice(0, NAME_MAX);
	if (!name) return null;
	if (row.kind === "api") {
		const api = parseApiProposal(row.api);
		if (!api) return null;
		return {
			kind: "api",
			id,
			name,
			description: typeof row.description === "string" ? row.description.trim().slice(0, DESCRIPTION_MAX) : "",
			icon: parseIcon(row.icon),
			api,
			...(row.reconnect === true ? { reconnect: true } : {}),
		};
	}
	if (row.kind === "custom") {
		const parsed = parseCustomMcpUrl(row.url, { allowLocal: true });
		if (!parsed.ok) return null;
		const auth = CUSTOM_AUTHS.find((item) => item === row.auth) ?? "oauth";
		return {
			kind: "custom",
			id,
			name,
			description: typeof row.description === "string" ? row.description.trim().slice(0, DESCRIPTION_MAX) : "",
			icon: parseIcon(row.icon),
			url: parsed.url.toString(),
			auth,
			...(row.reconnect === true ? { reconnect: true } : {}),
		};
	}
	const description = typeof row.description === "string" ? row.description.trim().slice(0, DESCRIPTION_MAX) : "";
	return {
		kind: row.kind,
		id,
		name,
		description,
		icon: parseIcon(row.icon),
		...(row.reconnect === true ? { reconnect: true } : {}),
		...(row.kind === "composio" && row.noAuth === true ? { noAuth: true } : {}),
	};
}

/** Conector nativo do Marketplace que cobre o app citado (id, slug do toolkit ou nome). */
export function findNativeCatalogEntryForApp(
	app: string,
	catalog: readonly McpCatalogEntry[] = MCP_CATALOG,
): McpCatalogEntry | null {
	const norm = app.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
	if (!norm) return null;
	const viaToolkit = nativeCatalogIdForToolkit(norm);
	const entry = catalog.find((item) => {
		if (item.availability !== "available") return false;
		const idNorm = item.id.replace(/[^a-z0-9]/g, "");
		const nameNorm = item.name.toLowerCase().replace(/[^a-z0-9]/g, "");
		return item.id === viaToolkit || idNorm === norm || nameNorm === norm;
	});
	return entry ?? null;
}

export function nativeLoginConnector(entry: McpCatalogEntry, reconnect: boolean): LoginConnector {
	return {
		kind: "native",
		id: entry.id,
		name: entry.name,
		description: entry.description,
		icon: entry.icon,
		...(reconnect ? { reconnect: true } : {}),
	};
}
