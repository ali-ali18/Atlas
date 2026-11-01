/**
 * Aprovação por tarefa: regras puras (sem I/O, relógio injetado).
 *
 * Depois que o usuário aprova um cartão de escrita REVERSÍVEL de conector, a mesma tool na mesma
 * conexão e conversa passa sem cartão por um tempo e até um teto de usos. Irreversível (apagar,
 * enviar) nunca entra: cada uma continua pedindo.
 */

import { hasOutwardVerb } from "./autonomy-tools.js";

export const MCP_TASK_GRANT_TTL_MS = 30 * 60_000;
export const MCP_TASK_GRANT_MAX_USES = 30;
/** Teto de vida da concessão contado da primeira aprovação: renovar nunca estende além disso. */
export const MCP_TASK_GRANT_MAX_LIFETIME_MS = 2 * 60 * 60_000;

/**
 * Quanto tempo a marca de conteúdo externo da CONVERSA vale. O conteúdo lido continua no contexto do modelo nos runs
 * seguintes (transcrição levada), então a marca só cai quando ele deixa de estar lá: ao compactar a conversa
 * (/compact reescreve a transcrição como resumo; o db apaga a marca) ou, no máximo, 24 h depois da última leitura.
 */
export const CONVERSATION_UNTRUSTED_TTL_MS = 24 * 60 * 60_000;

/** A conversa ainda carrega conteúdo externo no contexto? `untrustedAt` nulo ou mais velho que o TTL = não. */
export function isConversationUntrusted(untrustedAt: Date | null | undefined, now: Date): boolean {
	return !!untrustedAt && now.getTime() - untrustedAt.getTime() < CONVERSATION_UNTRUSTED_TTL_MS;
}

/**
 * Chave da concessão: a tool + o bot que pediu a tarefa. A conversa do bot-alvo é compartilhada entre quem pede
 * (o dono no chat e cada outro bot), então sem o solicitante a aprovação dada a um valeria para todos. Pedido do
 * próprio dono usa só o nome da tool (compatível com concessões antigas).
 */
export function mcpTaskGrantName(exposedName: string, requesterBotId?: string | null): string {
	return requesterBotId ? `${exposedName}#from:${requesterBotId}` : exposedName;
}

export type McpTaskGrantState = { uses: number; maxUses: number; expiresAt: Date };

/**
 * Só `write` reversível vira concessão; `irreversible` e `read` não. Com o nome da tool, verbo que atinge
 * terceiros (reply, invite, share, forward…) também não: servidores sem anotações (Composio) classificam
 * "reply" como `write`, e uma resposta a e-mail sai para fora da conta do usuário.
 */
export function canGrantMcpTask(actionClass: string | undefined, toolName?: string): boolean {
	return actionClass === "write" && !(toolName && hasOutwardVerb(toolName));
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
	"participants", "participant", "members", "collaborators", "reviewers", "sharewith", "permissions",
]);
const EXTERNAL_TARGET_SUFFIXES = ["email", "emails", "url", "urls", "webhook", "recipients", "attendees", "address", "addresses"];
const EXTERNAL_TARGET_MAX_DEPTH = 5;
const EMAIL_RE = /^(?:[^<>@,;]*<)?[^<>@\s,;]+@[^<>@\s,;]+\.[^<>@\s,;]+>?$/;
const URL_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+$/i;

function isEmptyTargetValue(value: unknown): boolean {
	if (value === null || value === undefined || value === false) return true;
	if (typeof value === "string") return value.trim() === "" || value.trim().toLowerCase() === "none";
	if (Array.isArray(value)) return value.every(isEmptyTargetValue);
	if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(isEmptyTargetValue);
	return false;
}

/**
 * Valor que, sozinho, é um endereço de e-mail (também "Nome <a@b.c>" e listas separadas por vírgula/ponto e vírgula)
 * ou uma URL: independe do nome do campo (conectores como o Composio usam chaves imprevisíveis). Texto livre com um
 * e-mail no meio de uma frase não conta. URL do próprio recurso do conector não tem exceção: na dúvida, conta.
 */
function isExternalTargetString(value: string): boolean {
	const text = value.trim();
	if (!text || text.length > 2000) return false;
	if (URL_RE.test(text)) return true;
	return text.split(/[,;]/).map((part) => part.trim()).filter(Boolean).some((part) => EMAIL_RE.test(part));
}

export function hasExternalTargetArgs(args: unknown, depth = 0): boolean {
	if (typeof args === "string") return isExternalTargetString(args);
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
 * Lista permitida (allowlist) de tools internas "limpas": o resultado é produzido inteiramente pelo Atlas (status, id,
 * card, eco do que o próprio modelo enviou) e não carrega texto de terceiros. QUALQUER outra tool marca a conversa
 * como tendo lido conteúdo que o usuário não escreveu (web, e-mail, arquivo, subagente, memória, busca, CI, GitHub,
 * conector MCP...). Na dúvida a tool NÃO entra aqui: o custo é só o Jev conferir cada uso da aprovação por tarefa.
 */
const CLEAN_INTERNAL_TOOLS = new Set([
	"propose_routine", "propose_questionnaire", "propose_connector", "propose_api_connection", "propose_custom_mcp",
	"propose_profile_update", "propose_bot", "propose_plan", "propose_skill", "propose_skill_change", "propose_skill_delete",
	"suggest_routine", "update_task_list", "todo_write", "track_items",
	"notify_user", "set_autonomy", "set_reasoning_effort", "schedule_followup", "cancel_followup", "reschedule_followup",
	"request_secrets", "secret_request", "email_create_mailbox", "shell_kill", "app_info", "current_time",
]);

/** Inverso da lista permitida: toda tool marca, salvo as internas limpas. Todo `mcp__*` marca, leitura ou escrita. */
export function isUntrustedContentTool(name: string): boolean {
	if (name.startsWith("mcp__")) return true;
	return !CLEAN_INTERNAL_TOOLS.has(name);
}
