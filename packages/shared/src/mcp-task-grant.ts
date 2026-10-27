/**
 * Aprovação por tarefa: regras puras (sem I/O, relógio injetado).
 *
 * Depois que o usuário aprova um cartão de escrita REVERSÍVEL de conector, a mesma tool na mesma
 * conexão e conversa passa sem cartão por um tempo e até um teto de usos. Irreversível (apagar,
 * enviar) nunca entra: cada uma continua pedindo.
 */

export const MCP_TASK_GRANT_TTL_MS = 30 * 60_000;
export const MCP_TASK_GRANT_MAX_USES = 30;
/** Teto de vida da concessão contado da primeira aprovação: renovar nunca estende além disso. */
export const MCP_TASK_GRANT_MAX_LIFETIME_MS = 2 * 60 * 60_000;

export type McpTaskGrantState = { uses: number; maxUses: number; expiresAt: Date };

/** Só `write` reversível vira concessão; `irreversible` e `read` não. */
export function canGrantMcpTask(actionClass: string | undefined): boolean {
	return actionClass === "write";
}

/** `now + 30 min`, nunca além de `createdAt + 2 h` (a concessão original não vira eterna por renovações). */
export function mcpTaskGrantExpiry(now: Date, createdAt: Date = now): Date {
	return new Date(Math.min(now.getTime() + MCP_TASK_GRANT_TTL_MS, createdAt.getTime() + MCP_TASK_GRANT_MAX_LIFETIME_MS));
}

export function isMcpTaskGrantUsable(grant: McpTaskGrantState, now: Date): boolean {
	return grant.uses < grant.maxUses && grant.expiresAt.getTime() > now.getTime();
}

/** "executado 3 vezes nesta tarefa" (a UI junta com "Aprovado ·"). */
export function describeMcpTaskGrantUses(uses: number): string {
	return `executado ${uses} ${uses === 1 ? "vez" : "vezes"} nesta tarefa`;
}

/**
 * Escrita com efeito fora da conta do usuário (convidado, destinatário, webhook, URL de destino) nunca
 * ganha nem consome aprovação por tarefa: um e-mail malicioso poderia pôr o alvo dele em cada chamada.
 */
const EXTERNAL_TARGET_KEYS = new Set([
	"attendees", "attendee", "guests", "guest", "invitees", "invitee", "to", "cc", "bcc", "recipients", "recipient",
	"email", "emails", "webhook", "webhooks", "url", "urls", "uri", "endpoint", "sendto", "sendupdates", "sendnotifications",
]);
const EXTERNAL_TARGET_SUFFIXES = ["email", "emails", "url", "urls", "webhook", "recipients", "attendees"];
const EXTERNAL_TARGET_MAX_DEPTH = 5;

function isEmptyTargetValue(value: unknown): boolean {
	if (value === null || value === undefined || value === false) return true;
	if (typeof value === "string") return value.trim() === "" || value.trim().toLowerCase() === "none";
	if (Array.isArray(value)) return value.every(isEmptyTargetValue);
	if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(isEmptyTargetValue);
	return false;
}

export function hasExternalTargetArgs(args: unknown, depth = 0): boolean {
	if (depth > EXTERNAL_TARGET_MAX_DEPTH || args === null || typeof args !== "object") return false;
	if (Array.isArray(args)) return args.slice(0, 100).some((item) => hasExternalTargetArgs(item, depth + 1));
	for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
		const norm = key.toLowerCase().replace(/[^a-z0-9]/g, "");
		if ((EXTERNAL_TARGET_KEYS.has(norm) || EXTERNAL_TARGET_SUFFIXES.some((suffix) => norm.endsWith(suffix))) && !isEmptyTargetValue(value)) return true;
		if (hasExternalTargetArgs(value, depth + 1)) return true;
	}
	return false;
}

/**
 * Tool cujo resultado volta ao modelo com conteúdo que o usuário não escreveu (página, e-mail, arquivo,
 * resultado de subagente ou de conector). Depois de uma delas, aprovação por tarefa não vale mais.
 */
const UNTRUSTED_CONTENT_TOOLS = new Set([
	"web_search", "web_extract", "navigate", "screenshot", "click", "type", "key", "scroll",
	"browser_snapshot", "browser_act", "browser_wait", "browser_read", "browser_find", "browser_text", "browser_links", "browser_click", "browser_type",
	"email_list", "email_read",
	"attachment_read", "attachment_list", "attachment_to_computer", "read_file", "grep", "list_files", "sandbox_read", "sandbox_list", "sandbox_download",
	"shell", "shell_output", "sandbox_shell", "sandbox_shell_wait", "run_code",
	"delegate_task", "api_call", "api_search", "github_compare", "github_list_repos",
	"artifact_read", "page_read", "read_cached_result", "inspect_presentation",
]);

export function isUntrustedContentTool(name: string, mcpReadOnly = false): boolean {
	if (name.startsWith("mcp__")) return mcpReadOnly;
	return UNTRUSTED_CONTENT_TOOLS.has(name);
}
