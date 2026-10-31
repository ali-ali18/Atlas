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

/** SHA-256 puro e síncrono (o `shared` roda também no navegador, sem `node:crypto`). */
function sha256Hex(text: string): string {
	const bytes = new TextEncoder().encode(text);
	const K = new Uint32Array(64);
	let n = 2;
	for (let i = 0; i < 64; ) {
		let prime = true;
		for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
		if (prime) { K[i++] = Math.floor((n ** (1 / 3) % 1) * 2 ** 32); }
		n++;
	}
	const H = new Uint32Array(8);
	for (let i = 0, m = 2; i < 8; m++) {
		let prime = true;
		for (let d = 2; d * d <= m; d++) if (m % d === 0) { prime = false; break; }
		if (prime) { H[i++] = Math.floor((m ** 0.5 % 1) * 2 ** 32); }
	}
	const total = Math.ceil((bytes.length + 9) / 64) * 64;
	const buf = new Uint8Array(total);
	buf.set(bytes);
	buf[bytes.length] = 0x80;
	const view = new DataView(buf.buffer);
	view.setUint32(total - 8, Math.floor((bytes.length * 8) / 2 ** 32));
	view.setUint32(total - 4, (bytes.length * 8) >>> 0);
	const w = new Uint32Array(64);
	const rotr = (x: number, r: number) => (x >>> r) | (x << (32 - r));
	for (let off = 0; off < total; off += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
			const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
			w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, h] = Array.from(H) as [number, number, number, number, number, number, number, number];
		for (let i = 0; i < 64; i++) {
			const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0;
			const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
			h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
		}
		[a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i]! + v) >>> 0; });
	}
	return Array.from(H, (v) => v.toString(16).padStart(8, "0")).join("");
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * Hash curto da DEFINIÇÃO da tool (descrição + schema de entrada). A marcação do dono vale para essa definição:
 * servidor que muda o que a tool faz ou aceita invalida a marca (volta a pedir confirmação).
 */
export function toolDefinitionHash(tool: Pick<McpToolInfo, "description" | "inputSchema">): string {
	return sha256Hex(stableJson({ d: tool.description ?? "", s: tool.inputSchema ?? {} })).slice(0, 16);
}

/** Como a marcação é guardada: a marca + o hash da definição que o dono confirmou (ausente = legado: pede de novo). */
export type StoredToolMark = { mark: ToolMark; hash?: string };
export type StoredToolMarks = Record<string, StoredToolMark>;

/** Lê o JSON do banco (aceita o formato antigo `"read"`, sem hash). */
export function parseStoredToolMarks(raw: unknown): StoredToolMarks {
	const out: StoredToolMarks = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
	for (const [name, value] of Object.entries(raw as Record<string, unknown>).slice(0, TOOL_MARKS_MAX)) {
		if (!name || name.length > TOOL_NAME_MAX_CHARS) continue;
		if (isToolMark(value)) out[name] = { mark: value };
		else if (value && typeof value === "object" && isToolMark((value as { mark?: unknown }).mark)) {
			const hash = (value as { hash?: unknown }).hash;
			out[name] = { mark: (value as { mark: ToolMark }).mark, ...(typeof hash === "string" && hash.length <= 64 ? { hash } : {}) };
		}
	}
	return out;
}

/**
 * Marcas que valem agora (hash igual ao da definição atual) e as que o servidor mudou (`stale`). Com a lista de
 * tools vazia (cache ainda não carregado) nada vale nem fica obsoleto: a marca espera, sem ser apagada.
 */
export function resolveToolMarks(
	stored: StoredToolMarks,
	tools: readonly Pick<McpToolInfo, "name" | "description" | "inputSchema">[],
): { marks: ToolMarks; stale: string[] } {
	const marks: ToolMarks = {};
	const stale: string[] = [];
	for (const tool of tools) {
		const entry = stored[tool.name];
		if (!entry) continue;
		if (entry.hash !== undefined && entry.hash === toolDefinitionHash(tool)) marks[tool.name] = entry.mark;
		else stale.push(tool.name);
	}
	return { marks, stale };
}

/** Grava `next` (marcas efetivas) com o hash atual; marca obsoleta que o dono não tocou continua guardada (a UI avisa). */
export function buildStoredToolMarks(
	next: ToolMarks,
	stored: StoredToolMarks,
	tools: readonly Pick<McpToolInfo, "name" | "description" | "inputSchema">[],
): StoredToolMarks {
	const out: StoredToolMarks = {};
	for (const tool of tools) {
		const mark = next[tool.name];
		if (mark) out[tool.name] = { mark, hash: toolDefinitionHash(tool) };
		else if (stored[tool.name] && stored[tool.name]!.hash !== toolDefinitionHash(tool)) out[tool.name] = stored[tool.name]!;
	}
	return out;
}

/** O servidor MCP disse algo sobre leitura/destruição desta tool: a anotação vale mais que a marcação. */
export function hasServerToolAnnotation(tool: Pick<McpToolInfo, "annotations">): boolean {
	const hints = tool.annotations;
	return hints?.readOnlyHint !== undefined || hints?.destructiveHint !== undefined;
}

/** Verbos de leitura no NOME. Só o nome promove a leitura: "status" e "check" ficam fora (também são substantivo/escrita). */
const READ_VERBS = new Set([
	"list", "get", "read", "search", "find", "fetch", "query", "view", "show", "describe", "lookup", "count", "retrieve", "browse",
	"listar", "obter", "buscar", "consultar", "consulta", "ver", "pesquisar", "mostrar", "exibir", "detalhar", "ler", "procurar", "contar",
]);
const WRITE_VERBS = new Set([
	"create", "update", "delete", "remove", "send", "set", "add", "edit", "post", "put", "patch", "write", "run", "execute", "approve", "cancel", "close", "emit", "generate", "merge", "publish", "pay", "transfer", "upload", "import",
	"change", "modify", "toggle", "reset", "apply", "assign", "move", "rename", "enable", "disable", "activate", "deactivate", "mark", "start", "stop", "retry", "sync", "save", "insert", "register", "open", "reopen",
	"criar", "alterar", "atualizar", "excluir", "apagar", "enviar", "emitir", "gerar", "aprovar", "cancelar", "registrar", "adicionar", "editar", "inserir", "salvar", "incluir", "remover", "pagar", "importar", "executar", "fechar",
	"mudar", "modificar", "ativar", "desativar", "mover", "renomear", "reiniciar", "aplicar", "marcar", "abrir", "reabrir", "iniciar", "parar", "sincronizar",
]);

function tokensOf(text: string): string[] {
	return toolNameTokens(text);
}

/**
 * Sugestão a partir do nome e da descrição. A sugestão `read` SÓ sai do NOME (verbo de leitura, sem verbo de
 * escrita ou irreversível); a descrição só pode rebaixar para escrita, nunca promover (texto do servidor é dado
 * não confiável). Nome sem verbo reconhecível = escrita.
 */
export function suggestToolMark(tool: Pick<McpToolInfo, "name" | "description">): ToolMark {
	const name = tokensOf(tool.name);
	if (hasIrreversibleToolName(tool.name)) return "write";
	if (name.some((token) => WRITE_VERBS.has(token))) return "write";
	if (!name.some((token) => READ_VERBS.has(token))) return "write";
	const description = (tool.description ?? "").slice(0, 400);
	if (tokensOf(description).some((token) => WRITE_VERBS.has(token)) || hasIrreversibleToolName(description)) return "write";
	return "read";
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
	// Cache de ferramentas vazio (conector ainda sem lista): não há como validar nada, então nada muda.
	if (tools.length === 0) return { ...current };
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

/**
 * Pedido é IMPERATIVO: o verbo abre a frase ou vem depois de "pode/por favor/quero que". Frase descritiva ("o ERP
 * está em modo somente leitura para as ferramentas de consulta") não conta. Entrada já sem acento e em minúsculas.
 */
const REQUEST_LEAD = String.raw`(?:^|[.!?\n]\s*)(?:(?:por favor|pf|please|entao|agora|e|tambem)[, ]+)*(?:(?:voce |vc |tu |could you |can you |would you |pode |podia |poderia |consegue |quero que |preciso que |gostaria que |i want you to |please )+)?`;
const MARK_REQUEST_PATTERNS: RegExp[] = [
	new RegExp(`${REQUEST_LEAD}(?:marca|marque|marcar|defina|define|definir|configura|configure|configurar|deixa|deixe|deixar|trate|trata|tratar|mark|set|treat|make|flag)\\b[^.!?\\n]{0,80}\\b(?:so|somente|apenas|only) (?:de )?(?:leitura|consulta)\\b`),
	new RegExp(`${REQUEST_LEAD}(?:marca|marque|marcar|defina|define|definir|configura|configure|configurar|deixa|deixe|deixar|trate|trata|tratar|mark|set|treat|make|flag)\\b[^.!?\\n]{0,80}\\bread[- ]?only\\b`),
	new RegExp(`${REQUEST_LEAD}(?:confirma|confirme|confirmar|aceita|aceite|aceitar|confirm|accept)\\b[^.!?\\n]{0,40}\\bsugest`),
	new RegExp(`${REQUEST_LEAD}nao precisa (?:mais )?(?:de )?(?:perguntar|aprovacao|confirmacao)\\b[^.!?\\n]{0,60}\\b(?:consultas?|leituras?)\\b`),
];

/**
 * Pedido explícito do dono de marcar ferramentas como leitura. Só a fala HUMANA conta: o caller passa a última fala
 * de um run `origin: "chat"` (fala de outro bot chega como role "user" em run `origin: "bot"` e não vale).
 */
export function looksLikeToolMarkRequest(text: string): boolean {
	const clipped = text.slice(0, 400);
	const normalized = clipped.normalize("NFKD").replace(/[\u0300-\u036f\u200b-\u200f\u2060\ufeff]/g, "").toLowerCase();
	return MARK_REQUEST_PATTERNS.some((pattern) => pattern.test(normalized));
}
