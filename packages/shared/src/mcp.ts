/**
 * Conectores MCP (marketplace): tipos públicos e nomes de tools.
 *
 * Tools de conector chegam ao modelo como `mcp__<slug>__<tool>`. O nome é
 * sanitizado para o formato aceito pelos provedores (`[a-zA-Z0-9_-]`, até 64
 * chars); a resolução volta pelo mapa do registry, nunca por parsing do nome.
 */

export type McpAuthType = "oauth" | "api_key" | "none";

export type McpConnectionStatus =
	| "pending_auth"
	| "connected"
	| "error"
	| "disabled";

export type McpToolAnnotations = {
	title?: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
};

/** Snapshot de uma tool do `listTools()` guardado em `toolsCacheJson`. */
export type McpToolInfo = {
	name: string;
	title?: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	annotations?: McpToolAnnotations;
};

/** Conexão como a API/UI enxergam: nunca inclui segredos. */
export type McpConnectionView = {
	id: string;
	catalogId: string | null;
	slug: string;
	name: string;
	url: string;
	authType: McpAuthType;
	status: McpConnectionStatus;
	tools: McpToolInfo[];
	disabledTools: string[];
	confirmWrites: boolean;
	lastError: string | null;
	/** Apelido da conta (várias contas do mesmo conector); null = sem apelido. */
	accountLabel: string | null;
	createdAt: string;
	updatedAt: string;
};

export const MCP_TOOL_PREFIX = "mcp__";
export const MCP_TOOL_NAME_MAX_CHARS = 64;
const MCP_SLUG_MAX_CHARS = 20;

function sanitizeNamePart(raw: string): string {
	return raw
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-zA-Z0-9_-]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^[_-]+|[_-]+$/g, "");
}

/** Apelido da conta cabe em uma linha de cartão/ferramenta. */
export const ACCOUNT_LABEL_MAX_CHARS = 60;

/** Normaliza o apelido de conta: espaços colapsados, sem quebras, no máximo 60 chars; vazio = null. */
export function normalizeAccountLabel(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const label = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, ACCOUNT_LABEL_MAX_CHARS).trim();
	return label || null;
}

/** "Notion" + "Notion pessoal" → "Notion — Notion pessoal"; sem apelido, só o nome. */
export function connectorAccountName(name: string, accountLabel?: string | null): string {
	const label = accountLabel?.trim();
	return label ? `${name} — ${label}` : name;
}

/** "Google Drive" → "google_drive" (curto, estável, seguro para nome de tool). */
export function slugifyConnectorName(name: string): string {
	const slug = sanitizeNamePart(name).toLowerCase().slice(0, MCP_SLUG_MAX_CHARS);
	return slug.replace(/[_-]+$/g, "") || "mcp";
}

/**
 * `mcp__<slug>__<tool>` com no máximo 64 chars. Se a tool não couber, corta e
 * acrescenta um hash curto do nome original para não colidir.
 */
export function mcpToolName(slug: string, toolName: string): string {
	const prefix = `${MCP_TOOL_PREFIX}${slugifyConnectorName(slug)}__`;
	const tool = sanitizeNamePart(toolName) || "tool";
	const full = `${prefix}${tool}`;
	if (full.length <= MCP_TOOL_NAME_MAX_CHARS) return full;
	const hash = shortHash(toolName);
	const room = MCP_TOOL_NAME_MAX_CHARS - prefix.length - hash.length - 1;
	return `${prefix}${tool.slice(0, Math.max(1, room))}_${hash}`;
}

export function isMcpToolName(name: string): boolean {
	return name.startsWith(MCP_TOOL_PREFIX);
}

/**
 * Só é leitura quando o servidor declara `readOnlyHint: true` (e não diz que
 * é destrutiva). Sem anotação, trata como escrita: pede confirmação no chat e
 * fica fora de rotinas.
 */
export function isReadOnlyMcpTool(tool: Pick<McpToolInfo, "annotations">): boolean {
	return (
		tool.annotations?.readOnlyHint === true &&
		tool.annotations?.destructiveHint !== true
	);
}

function shortHash(value: string): string {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36).slice(0, 6);
}
