import type { McpToolInfo } from "./mcp.js";
import { composioToolkitOfTool } from "./source-category.js";

/**
 * Composio (opcional, chave própria do usuário): tipos públicos e regras puras.
 * A conexão `composio` é uma linha `McpConnection` comum; os segredos (chave,
 * URL do servidor MCP com o `user_id` derivado) ficam só no cofre.
 */

export const COMPOSIO_CATALOG_ID = "composio";
export const COMPOSIO_NAME = "Composio";
/** URL pública guardada na coluna `url` (a real, com `user_id`, vai no cofre). */
export const COMPOSIO_PUBLIC_MCP_URL = "https://backend.composio.dev/v3/mcp";

/** Toolkit do Composio → conector nativo do Atlas que cobre o mesmo app. */
const NATIVE_BY_TOOLKIT: Readonly<Record<string, string>> = {
	github: "github",
	notion: "notion",
	slack: "slack",
	gmail: "gmail",
	googledrive: "google_drive",
	googlecalendar: "google_calendar",
	googlesheets: "google_sheets",
	firecrawl: "firecrawl",
	bravesearch: "brave_search",
};

/** `googlecalendar` → `google_calendar`; `null` quando o Atlas não tem conector nativo. */
export function nativeCatalogIdForToolkit(toolkitSlug: string): string | null {
	return NATIVE_BY_TOOLKIT[toolkitSlug.trim().toLowerCase().replace(/[_-]/g, "")] ?? null;
}

const COMPOSIO_READ_VERBS = new Set([
	"list",
	"get",
	"fetch",
	"search",
	"read",
	"find",
	"retrieve",
	"query",
	"view",
	"check",
	"describe",
]);

/** Verbos que escrevem ou agem: com qualquer um deles a tool nunca é leitura (na dúvida, não é leitura). */
const COMPOSIO_WRITE_VERBS = new Set([
	"create", "send", "delete", "remove", "update", "add", "post", "patch", "put", "insert", "move", "reply", "forward",
	"archive", "trash", "modify", "set", "write", "upload", "accept", "decline", "cancel", "clear", "import", "run",
	"execute", "invoke", "batch", "quick", "label", "mark", "star", "share", "invite", "approve", "reject", "merge",
	"close", "reopen", "assign", "edit", "replace", "rename", "restore", "empty", "unsubscribe", "subscribe", "watch",
	"stop", "start", "submit", "publish", "schedule", "book", "pay", "transfer", "sync", "disconnect", "revoke",
]);

/**
 * Heurística para tools do Composio, que não garantem `readOnlyHint`: tira o prefixo do toolkit
 * (`GMAIL_`, `GOOGLECALENDAR_`, `GOOGLE_CALENDAR_`, via `composioToolkitOfTool`) e olha os termos que sobram.
 * É leitura quando o verbo de leitura abre ou fecha o nome (`GMAIL_FETCH_EMAILS`, `GOOGLECALENDAR_EVENTS_LIST`,
 * `GOOGLE_CALENDAR_LIST_EVENTS`) e nenhum termo é verbo de escrita. Qualquer outra coisa (inclusive nome fora do
 * padrão) é escrita.
 */
export function isComposioReadToolName(name: string): boolean {
	const parts = name.split("_").filter(Boolean);
	if (parts.length < 2) return false;
	const toolkit = composioToolkitOfTool(name);
	const skip = parts[0]!.toLowerCase().replace(/[^a-z0-9]+/g, "") === toolkit ? 1 : 2;
	const verbs = parts
		.slice(skip)
		.join(" ")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	if (verbs.length === 0 || verbs.some((term) => COMPOSIO_WRITE_VERBS.has(term))) return false;
	return COMPOSIO_READ_VERBS.has(verbs[0]!) || COMPOSIO_READ_VERBS.has(verbs[verbs.length - 1]!);
}

/** Toolkits internos do Composio (as meta-tools): nunca aparecem como app. */
const COMPOSIO_META_TOOLKITS: ReadonlySet<string> = new Set(["composio"]);

/**
 * Meta-tools do Composio. São opacas (executam qualquer outra tool ou um shell
 * remoto), então o Atlas as evita: não dá para classificar leitura/escrita nem
 * aplicar a autonomia por tool. O agente usa só as tools reais de cada app.
 */
const COMPOSIO_META_TOOLS: ReadonlySet<string> = new Set([
	"COMPOSIO_SEARCH_TOOLS",
	"COMPOSIO_MULTI_EXECUTE_TOOL",
	"COMPOSIO_REMOTE_BASH_TOOL",
	"COMPOSIO_REMOTE_WORKBENCH",
	"COMPOSIO_MANAGE_CONNECTIONS",
	"COMPOSIO_GET_TOOL_SCHEMAS",
	"COMPOSIO_WAIT_FOR_CONNECTIONS",
]);

export function isComposioMetaToolkit(slug: string): boolean {
	return COMPOSIO_META_TOOLKITS.has(slug.trim().toLowerCase());
}

/**
 * Webhooks do GitHub são do sistema: o gatilho de rotina cria/atualiza/apaga o
 * hook com a URL e o segredo de assinatura certos (hook-ops.ts, server-side).
 * O modelo, com essas tools à mão, criava hooks por conta própria apontando
 * pra raiz do domínio e sem segredo — entregas que nunca chegam. Só leitura
 * (LIST_/GET_) continua disponível para diagnóstico.
 */
const SYSTEM_MANAGED_TOOL = /^GITHUB_(?!LIST_|GET_)\w*WEBHOOK/;

export function isComposioMetaTool(name: string): boolean {
	const upper = name.trim().toUpperCase();
	return COMPOSIO_META_TOOLS.has(upper) || SYSTEM_MANAGED_TOOL.test(upper);
}

export function dropComposioMetaTools<T extends { name: string }>(tools: readonly T[]): T[] {
	return tools.filter((tool) => !isComposioMetaTool(tool.name));
}

/**
 * Tira as tools de toolkits que já existem como conector nativo conectado
 * (o nativo é o padrão; evita duas tools para o mesmo app).
 */
export function dropNativeDuplicateTools(
	tools: readonly McpToolInfo[],
	connectedNativeIds: ReadonlySet<string>,
): McpToolInfo[] {
	if (connectedNativeIds.size === 0) return [...tools];
	return tools.filter((tool) => {
		const prefix = tool.name.split("_")[0] ?? "";
		const native = nativeCatalogIdForToolkit(prefix) ?? nativeFromLongPrefix(tool.name);
		return !(native && connectedNativeIds.has(native));
	});
}

/** `GOOGLE_CALENDAR_*` / `BRAVE_SEARCH_*`: toolkits cujo slug tem separador. */
function nativeFromLongPrefix(name: string): string | null {
	const parts = name.split("_");
	return nativeCatalogIdForToolkit(parts.slice(0, 2).join("")) ?? null;
}

/** Item da lista de apps (nunca contém chave nem URL de servidor). */
export type ComposioToolkitView = {
	slug: string;
	name: string;
	description: string | null;
	logo: string | null;
	connected: boolean;
	/** O app funciona sem login (`no_auth` do Composio): "Ativar" em vez de "Conectar". */
	noAuth: boolean;
	/** Conector nativo equivalente (o nativo é o padrão). */
	nativeCatalogId: string | null;
};

export type ComposioConnectedAppView = {
	id: string;
	toolkit: string;
	toolkitName: string;
	/** App sem login ativado no servidor MCP (não há conta conectada no Composio). */
	noAuth?: boolean;
};

/** Id da "conexão" de um app sem login (não existe conta no Composio para ele). */
export const COMPOSIO_NO_AUTH_ID_PREFIX = "noauth_";

export function composioNoAuthConnectionId(toolkitSlug: string): string {
	return `${COMPOSIO_NO_AUTH_ID_PREFIX}${toolkitSlug}`;
}

/** Slug do app sem login a partir do id da conexão; `null` se for conta normal. */
export function composioNoAuthSlugFromId(id: string): string | null {
	return id.startsWith(COMPOSIO_NO_AUTH_ID_PREFIX)
		? parseComposioToolkitSlug(id.slice(COMPOSIO_NO_AUTH_ID_PREFIX.length))
		: null;
}

export type ComposioStatusView = {
	configured: boolean;
	/** `••••abcd`: só os 4 últimos caracteres. */
	keyHint: string | null;
	secretBoxReady: boolean;
	toolCount: number;
};

/** Valida a chave colada pelo usuário (formato solto: só tamanho e caracteres). */
export function parseComposioApiKey(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const key = raw.trim();
	if (key.length < 8 || key.length > 200) return null;
	return /^[A-Za-z0-9._~+-]+$/.test(key) ? key : null;
}

export function maskComposioKey(key: string): string {
	return `••••${key.slice(-4)}`;
}

/** Slug de toolkit aceito nas rotas (nunca confiar no que vem do body). */
export function parseComposioToolkitSlug(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const slug = raw.trim().toLowerCase();
	return /^[a-z0-9][a-z0-9_-]{0,59}$/.test(slug) ? slug : null;
}

/** Itens por página do catálogo (padrão e teto aceito pela API). */
export const COMPOSIO_PAGE_SIZE_DEFAULT = 24;
export const COMPOSIO_PAGE_SIZE_MAX = 50;

export type ComposioToolkitsPageView = {
	items: ComposioToolkitView[];
	/** Cursor opaco da próxima página; `null` na última. */
	nextCursor: string | null;
	/** Total do catálogo para o filtro atual, quando o Composio informa. */
	totalItems: number | null;
};

export type ComposioCategoryView = { id: string; name: string };

export type ComposioToolkitsQuery = {
	search?: string;
	cursor?: string;
	category?: string;
	limit: number;
	sort: "usage" | "alphabetically";
};

/**
 * Valida os parâmetros de `GET /v1/composio/toolkits`. Busca e cursor são
 * aparados (o cursor é opaco, só limitamos caracteres e tamanho); limite,
 * categoria e ordenação inválidos viram erro em vez de serem repassados.
 */
export function parseComposioToolkitsQuery(
	raw: Partial<Record<"search" | "cursor" | "category" | "limit" | "sort", string | undefined>>,
): { ok: true; value: ComposioToolkitsQuery } | { ok: false; error: string } {
	const search = (raw.search ?? "").trim().slice(0, 80);
	const cursor = (raw.cursor ?? "").trim();
	if (cursor && !/^[A-Za-z0-9_\-=+/.:]{1,300}$/.test(cursor)) return { ok: false, error: "Cursor inválido" };
	const category = (raw.category ?? "").trim().toLowerCase();
	if (category && !/^[a-z0-9][a-z0-9_-]{0,59}$/.test(category)) return { ok: false, error: "Categoria inválida" };
	let limit = COMPOSIO_PAGE_SIZE_DEFAULT;
	if (raw.limit !== undefined && raw.limit !== "") {
		const parsed = Number(raw.limit);
		if (!Number.isInteger(parsed) || parsed < 1 || parsed > COMPOSIO_PAGE_SIZE_MAX) {
			return { ok: false, error: `Limite inválido (1 a ${COMPOSIO_PAGE_SIZE_MAX})` };
		}
		limit = parsed;
	}
	const sort = raw.sort === undefined || raw.sort === "" ? "usage" : raw.sort;
	if (sort !== "usage" && sort !== "alphabetically") return { ok: false, error: "Ordenação inválida" };
	return {
		ok: true,
		value: {
			...(search ? { search } : {}),
			...(cursor ? { cursor } : {}),
			...(category ? { category } : {}),
			limit,
			sort,
		},
	};
}
