/**
 * Marcação de ferramentas de conector pelo dono: "leitura" ou "escreve".
 *
 * Servidor MCP sem anotação (`readOnlyHint`) é tratado como escrita, então toda consulta de um ERP personalizado
 * pedia cartão. O dono pode marcar o que só lê. Precedência (ver `classifyMcpTool`): anotação do servidor (quando
 * vem) > marcação do dono > padrão (sem anotação = escrita reversível). A SUGESTÃO automática nunca vale sozinha:
 * só entra em `toolMarks` depois que o dono confirma. Funções puras, sem I/O.
 */

import type { McpToolInfo } from "./mcp.js";
import { hasIrreversibleToolName, toolNameTokens } from "./autonomy-tools.js";

export type ToolMark = "read" | "write";
export type ToolMarks = Record<string, ToolMark>;

export const TOOL_MARKS_MAX = 200;
const TOOL_NAME_MAX_CHARS = 200;

export function isToolMark(value: unknown): value is ToolMark {
	return value === "read" || value === "write";
}

/** Valida o JSON vindo do banco ou do corpo da requisição: nunca confia no formato. */
export function parseToolMarks(raw: unknown): ToolMarks {
	const out: ToolMarks = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
	for (const [name, mark] of Object.entries(raw as Record<string, unknown>).slice(0, TOOL_MARKS_MAX)) {
		if (name && name.length <= TOOL_NAME_MAX_CHARS && isToolMark(mark)) out[name] = mark;
	}
	return out;
}

/** O servidor MCP disse algo sobre leitura/destruição desta tool: a anotação vale mais que a marcação. */
export function hasServerToolAnnotation(tool: Pick<McpToolInfo, "annotations">): boolean {
	const hints = tool.annotations;
	return hints?.readOnlyHint !== undefined || hints?.destructiveHint !== undefined;
}

const READ_VERBS = new Set([
	"list", "get", "read", "search", "find", "fetch", "query", "view", "show", "describe", "lookup", "count", "check", "status", "retrieve", "browse",
	"listar", "obter", "buscar", "consultar", "consulta", "ver", "pesquisar", "mostrar", "exibir", "detalhar", "ler", "leitura", "procurar", "contar", "verificar",
]);
const WRITE_VERBS = new Set([
	"create", "update", "delete", "remove", "send", "set", "add", "edit", "post", "put", "patch", "write", "run", "execute", "approve", "cancel", "close", "emit", "generate", "merge", "publish", "pay", "transfer", "upload", "import",
	"criar", "alterar", "atualizar", "excluir", "apagar", "enviar", "emitir", "gerar", "aprovar", "cancelar", "registrar", "adicionar", "editar", "inserir", "salvar", "incluir", "remover", "pagar", "importar", "executar", "fechar",
]);

function tokensOf(text: string): string[] {
	return toolNameTokens(text.normalize("NFD").replace(/[̀-ͯ]/g, ""));
}

/**
 * Sugestão a partir do nome e da descrição. Verbo de escrita no nome vence; sem verbo no nome, a descrição decide
 * (escrita em qualquer parte vence); na dúvida, escreve.
 */
export function suggestToolMark(tool: Pick<McpToolInfo, "name" | "description">): ToolMark {
	const name = tokensOf(tool.name);
	if (hasIrreversibleToolName(tool.name)) return "write";
	if (name.some((token) => WRITE_VERBS.has(token))) return "write";
	if (name.some((token) => READ_VERBS.has(token))) return "read";
	const description = tokensOf((tool.description ?? "").slice(0, 400));
	if (description.some((token) => WRITE_VERBS.has(token))) return "write";
	return description.some((token) => READ_VERBS.has(token)) ? "read" : "write";
}

/**
 * Por que esta tool NÃO aceita ser marcada como leitura (texto para o usuário, pt-BR), ou `null` se aceita.
 * Servidor que anota vence; verbo irreversível no nome (enviar, excluir, emitir, pagar…) nunca vira leitura.
 */
export function toolMarkRefusal(tool: Pick<McpToolInfo, "name" | "annotations">, mark: ToolMark = "read"): string | null {
	if (hasServerToolAnnotation(tool)) return "o próprio conector já informa se ela só lê";
	if (mark === "read" && hasIrreversibleToolName(tool.name)) return "o nome indica uma ação que não dá para desfazer (enviar, excluir, emitir, pagar…), então ela sempre pede aprovação";
	return null;
}

/** Tools que ainda esperam o dono: sem anotação do servidor, sem marcação confirmada. */
export function pendingToolMarkSuggestions(
	tools: readonly McpToolInfo[],
	confirmed: ToolMarks,
	disabledTools: readonly string[] = [],
): ToolMarks {
	const out: ToolMarks = {};
	for (const tool of tools) {
		if (hasServerToolAnnotation(tool) || confirmed[tool.name] || disabledTools.includes(tool.name)) continue;
		out[tool.name] = suggestToolMark(tool);
	}
	return out;
}

/** Marcações depois de aplicar um pedido: só tools que existem no conector, nunca as que o servidor anota. */
export function mergeToolMarks(
	current: ToolMarks,
	patch: ToolMarks,
	tools: readonly Pick<McpToolInfo, "name" | "annotations">[],
): ToolMarks {
	const known = new Map(tools.map((tool) => [tool.name, tool]));
	const next: ToolMarks = {};
	for (const [name, mark] of Object.entries(current)) if (known.has(name)) next[name] = mark;
	for (const [name, mark] of Object.entries(patch)) {
		const tool = known.get(name);
		if (tool && toolMarkRefusal(tool, mark) === null) next[name] = mark;
	}
	return next;
}

/** "Só leitura" na tela e no chat: o rótulo da ferramenta, nunca o nome interno. */
export function toolDisplayLabel(tool: Pick<McpToolInfo, "name" | "title">): string {
	const title = tool.title?.trim();
	if (title) return title;
	const words = tool.name.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim().toLowerCase();
	return words ? words.charAt(0).toUpperCase() + words.slice(1) : tool.name;
}

const MARK_REQUEST_PATTERNS: RegExp[] = [
	/\b(marca|marque|marcar|defina|define|configura|configure|deixa|deixe|trate|trata)\b[^.!?\n]{0,60}\b(so|somente|apenas) (de )?(leitura|consulta)\b/,
	/\b(so|somente|apenas) (de )?(leitura|consulta)\b[^.!?\n]{0,60}\b(ferramentas?|consultas?|conector|erp)\b/,
	/\b(ferramentas?|consultas?)\b[^.!?\n]{0,60}\b(so|somente|apenas) (de )?(leitura|consulta)\b/,
	/\bread[- ]?only\b[^.!?\n]{0,60}\b(tools?|connector)\b/,
	/\b(confirm[ao]r?|confirme|aceit[ao]r?|aceite)\b[^.!?\n]{0,40}\bsugest/,
	/\bnao (precisa|precisa mais) (de )?(perguntar|aprovacao|confirmacao)\b[^.!?\n]{0,60}\b(consultas?|leituras?)\b/,
];

/** Pedido explícito do dono de marcar ferramentas como leitura. Só a fala dele conta (o caller passa a última fala). */
export function looksLikeToolMarkRequest(text: string): boolean {
	const clipped = text.slice(0, 400);
	const normalized = clipped.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
	return MARK_REQUEST_PATTERNS.some((pattern) => pattern.test(normalized));
}
