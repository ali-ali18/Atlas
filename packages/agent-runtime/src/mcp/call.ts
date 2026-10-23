import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { clipWithNotice, type ClipHintFn } from "./clip-notice.js";
import type { McpToolInfo } from "@workspace/shared";
import type { McpClientConfig, McpClientPool } from "./client-pool.js";
import type { GithubIdentityBlock } from "../github/write/gate.js";
import { isMcpAuthFailure } from "./auth-marker.js";
import { withMcpErrorHint } from "./hints.js";
import { MCP_RETRY_BACKOFF_MS, shouldRetryMcpFailure } from "./retry.js";
import { redactSecrets, sanitizeErrorMessage } from "./sanitize.js";

/**
 * Conector `builtin://` roda num `Server` MCP em memória: um `UnauthorizedError`
 * jogado lá dentro atravessa o protocolo JSON-RPC e chega aqui como `McpError`
 * genérico (a classe não sobrevive à serialização). Usa o teste único
 * `isMcpAuthFailure` (auth-marker.ts), mesmo sinal de `probeMcpServer`.
 */
function isAuthFailure(error: unknown): boolean {
	return isMcpAuthFailure(error);
}

export const MCP_CALL_TIMEOUT_MS = 30_000;
/** Teto do texto devolvido ao modelo (abaixo do stub do último grupo, 24k). */
export const MCP_RESULT_MAX_CHARS = 20_000;
const LIST_TOOLS_MAX_PAGES = 10;

export type McpCallResult = {
	ok: boolean;
	text: string;
	truncated: boolean;
	/** Texto inteiro (já compacto) quando o corte descartou parte dele; quem chama guarda para reler. */
	fullText?: string;
	images?: Array<{ data: string; mimeType: string }>;
	/** Token expirado/revogado sem refresh: a conexão precisa ser refeita. */
	authFailed?: boolean;
	/** Args opcionais vazios removidos antes da chamada (debug, não vai ao usuário). */
	prunedArgs?: string[];
	/** Escrita sem resposta conclusiva (timeout, queda, abort): pode ter sido aplicada. */
	uncertain?: boolean;
	/** Escrita no GitHub bloqueada: o repositório não está no app (ou a ação não é do app). Nada foi enviado; vira cartão. */
	githubIdentity?: GithubIdentityBlock;
};

type ContentPart = Record<string, unknown>;

function partToText(part: ContentPart): string {
	switch (part.type) {
		case "text":
			return typeof part.text === "string" ? part.text : "";
		case "image":
			return "[imagem omitida]";
		case "audio":
			return "[áudio omitido]";
		case "resource_link":
			return `[recurso] ${String(part.name ?? "")} ${String(part.uri ?? "")}`.trim();
		case "resource": {
			const resource = (part.resource ?? {}) as Record<string, unknown>;
			if (typeof resource.text === "string") return resource.text;
			return `[recurso binário] ${String(resource.uri ?? "")}`.trim();
		}
		default:
			return "";
	}
}

/** CallToolResult (formato atual ou legado `toolResult`) → texto único. */
export function normalizeCallToolResult(result: unknown): { ok: boolean; text: string; images?: Array<{ data: string; mimeType: string }> } {
	const record = (result ?? {}) as Record<string, unknown>;
	const isError = record.isError === true;
	const parts = Array.isArray(record.content) ? (record.content as ContentPart[]) : [];
	const images = parts.filter((part): part is ContentPart & { data: string; mimeType: string } => part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string" && part.data.length <= 14_000_000 && /^image\/(png|jpeg|webp|gif)$/.test(part.mimeType));
	let text = parts.map(partToText).filter(Boolean).join("\n\n");
	if (!text && record.structuredContent !== undefined) {
		text = JSON.stringify(record.structuredContent);
	}
	if (!text && record.toolResult !== undefined) {
		text = JSON.stringify(record.toolResult);
	}
	return { ok: !isError, text: text || (isError ? "erro sem mensagem" : "(sem conteúdo)"), ...(images.length ? { images: images.map(({ data, mimeType }) => ({ data, mimeType })) } : {}) };
}

/** Remove null, "", [] e {} (ruído de APIs verbosas como o Bling), recursivamente. */
function dropEmpty(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(dropEmpty);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			const cleaned = dropEmpty(item);
			if (cleaned === null || cleaned === "" || (Array.isArray(cleaned) && cleaned.length === 0)) continue;
			if (typeof cleaned === "object" && !Array.isArray(cleaned) && Object.keys(cleaned as object).length === 0) continue;
			out[key] = cleaned;
		}
		return out;
	}
	return value;
}

/**
 * JSON minificado e sem campos vazios, antes de medir o tamanho: mais itens cabem
 * no teto sem cortar. Genérico (qualquer conector). Texto que não é JSON, ou que
 * não encolhe, volta intacto.
 */
export function compactJsonText(text: string): string {
	const trimmed = text.trim();
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return text;
	try {
		const compact = JSON.stringify(dropEmpty(JSON.parse(trimmed)));
		return compact.length < text.length ? compact : text;
	} catch {
		return text;
	}
}

export function capResultText(text: string, maxChars = MCP_RESULT_MAX_CHARS, hint?: ClipHintFn): {
	text: string;
	truncated: boolean;
} {
	return clipWithNotice(text, maxChars, hint);
}

/** Falhas em que a requisição pode ter chegado ao servidor antes de cair. */
const UNCERTAIN_OUTCOME = /timeout|timed out|econnreset|socket hang up|\b5\d\d\b/i;
export const UNCERTAIN_WRITE_NOTE =
	"This write was not retried and may or may not have been applied. Check the current state (read or list the resource) before trying again, and only repeat it if the change is missing.";

type AttemptOutcome = { result: McpCallResult; retryable: boolean };

export async function callMcpTool(input: {
	pool: McpClientPool;
	config: McpClientConfig;
	toolName: string;
	args: Record<string, unknown>;
	secrets?: readonly string[];
	signal?: AbortSignal;
	/** Sobrescreve o timeout do conector (`config.callTimeoutMs`) e o padrão. */
	timeoutMs?: number;
	maxChars?: number;
	/** Dica de paginação/filtro anexada ao aviso de corte (disciplina de execução). */
	clipHint?: (text: string) => ClipHintFn | undefined;
	/** Espera antes do retry único (injetável nos testes). */
	retryDelayMs?: number;
	/**
	 * A tool só lê (classe `read` do registry). Só leitura é retentada: escrita
	 * nunca, mesmo com `idempotentHint` (indício do servidor, não garantia).
	 */
	readOnly?: boolean;
}): Promise<McpCallResult> {
	const secrets = input.secrets ?? [];
	const timeout = input.timeoutMs ?? input.config.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS;

	const attempt = async (): Promise<AttemptOutcome> => {
		try {
			const raw = await input.pool.withClient(input.config, (client) =>
				client.callTool({ name: input.toolName, arguments: input.args }, undefined, {
					signal: input.signal,
					timeout,
				}),
				{ signal: input.signal },
			);
			const normalized = normalizeCallToolResult(raw);
			const redacted = redactSecrets(normalized.text, secrets);
			const compact = normalized.ok ? compactJsonText(redacted) : redacted;
			const capped = capResultText(compact, input.maxChars, input.clipHint?.(compact));
			return {
				result: { ok: normalized.ok, ...capped, ...(capped.truncated ? { fullText: compact } : {}), ...(normalized.images ? { images: normalized.images } : {}) },
				retryable: !normalized.ok && shouldRetryMcpFailure({ text: normalized.text }),
			};
		} catch (error) {
			const authFailed = isAuthFailure(error);
			const message = sanitizeErrorMessage(error, secrets);
			return {
				result: {
					ok: false,
					text: authFailed
						? "connector disconnected (login expired or revoked); call propose_connector with this app so the user can reconnect"
						: message,
					truncated: false,
					...(authFailed ? { authFailed } : {}),
				},
				retryable:
					!authFailed && !input.signal?.aborted && shouldRetryMcpFailure({ text: message }),
			};
		}
	};

	let outcome = await attempt();
	if (input.readOnly === true && outcome.retryable && !input.signal?.aborted) {
		await new Promise((resolve) => setTimeout(resolve, input.retryDelayMs ?? MCP_RETRY_BACKOFF_MS));
		outcome = await attempt();
	}
	const { result } = outcome;
	if (result.ok || result.authFailed) return result;
	// Escrita que falhou sem resposta conclusiva: o efeito pode ter sido aplicado.
	const uncertain =
		input.readOnly !== true && (UNCERTAIN_OUTCOME.test(result.text) || input.signal?.aborted === true);
	if (uncertain) result.text = `${result.text}
${UNCERTAIN_WRITE_NOTE}`;
	return {
		...result,
		...(uncertain ? { uncertain: true } : {}),
		text: withMcpErrorHint(input.config.catalogId, {
			toolName: input.toolName,
			args: input.args,
			text: result.text,
		}),
	};
}

/** listTools() paginado → snapshot para `toolsCacheJson`. */
export async function listMcpTools(client: Client): Promise<McpToolInfo[]> {
	const tools: McpToolInfo[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < LIST_TOOLS_MAX_PAGES; page += 1) {
		const result = await client.listTools(cursor ? { cursor } : undefined);
		for (const tool of result.tools) {
			tools.push({
				name: tool.name,
				title: tool.title ?? tool.annotations?.title,
				description: tool.description,
				inputSchema: tool.inputSchema as Record<string, unknown>,
				annotations: tool.annotations
					? {
							title: tool.annotations.title,
							readOnlyHint: tool.annotations.readOnlyHint,
							destructiveHint: tool.annotations.destructiveHint,
							idempotentHint: tool.annotations.idempotentHint,
							openWorldHint: tool.annotations.openWorldHint,
						}
					: undefined,
			});
		}
		cursor = result.nextCursor;
		if (!cursor) break;
	}
	return tools;
}
