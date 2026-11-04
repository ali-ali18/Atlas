import { isRetryableLlmError, type ChatTool } from "@workspace/llm";
import { redactSecrets } from "@workspace/shared";

/**
 * Falhas do motor v3 (desenho 2.5). Tudo honesto: o erro volta ao modelo como resultado da tool (`ok:false`) com a
 * mensagem real (sem segredo) e uma dica acionável; o run não morre por isso.
 */

export const UNKNOWN_STATUS_NOTE =
	"status unknown: the run was interrupted after this call was sent and its result was never recorded. Verify the current state before repeating any effect.";
export const SKIPPED_FOR_USER_MESSAGE = "Not executed: the user sent a new message. Read it and decide what to do next.";
export const SKIPPED_FOR_PARK = "Not executed: waiting for the user.";
export const SKIPPED_FOR_APPROVAL = "Not executed: waiting for the owner's answer on the previous action. Call it again after they answer.";

/** Mensagem real da falha, sem segredo e com tamanho limitado (o modelo e o inspetor recebem isto). */
export function honestError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error ?? "error");
	return redactSecrets(raw).slice(0, 2_000) || "error";
}

/** Normalização determinística do nome (minúsculas, `-`/espaço → `_`, camelCase → snake_case). */
export function normalizeToolName(name: string): string {
	return name
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[-\s.]+/g, "_")
		.toLowerCase();
}

function editDistance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i += 1) {
		let previous = row[0]!;
		row[0] = i;
		for (let j = 1; j <= b.length; j += 1) {
			const current = row[j]!;
			row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
			previous = current;
		}
	}
	return row[b.length]!;
}

/** Até 3 nomes próximos (distância de edição pequena ou um contém o outro), do mais parecido ao menos. */
export function closestToolNames(name: string, candidates: readonly string[], max = 3): string[] {
	const target = normalizeToolName(name);
	const limit = Math.max(2, Math.floor(target.length / 3));
	return candidates
		.map((candidate) => ({ candidate, distance: editDistance(target, candidate.toLowerCase()), contains: candidate.includes(target) || target.includes(candidate) }))
		.filter((entry) => entry.distance <= limit || entry.contains)
		.sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
		.slice(0, max)
		.map((entry) => entry.candidate);
}

export function unknownToolMessage(name: string, suggestions: readonly string[]): string {
	const clipped = name.slice(0, 80);
	return suggestions.length > 0
		? `Unknown tool "${clipped}". Closest available: ${suggestions.join(", ")}. Call one of them with its exact name.`
		: `Unknown tool "${clipped}". It does not exist in this run; use one of the tools you were given or tell the user it is not possible.`;
}

/** A tool existe no sistema, mas este run não a oferece (nem foi negada pela política): sem insistir. */
export function notOfferedMessage(name: string, suggestions: readonly string[]): string {
	const near = suggestions.length > 0 ? ` Closest available: ${suggestions.join(", ")}.` : "";
	return `Tool "${name.slice(0, 80)}" is not offered in this run.${near} Do not retry it; continue without it or tell the user what you could not do.`;
}

function typeOf(schema: unknown): string {
	if (!schema || typeof schema !== "object") return "unknown";
	const record = schema as { type?: unknown; enum?: unknown; items?: unknown };
	if (Array.isArray(record.enum)) return record.enum.slice(0, 6).map((value) => JSON.stringify(value)).join(" | ");
	if (record.type === "array") return `${typeOf(record.items)}[]`;
	if (typeof record.type === "string") return record.type === "integer" ? "number" : record.type;
	return "unknown";
}

/** Assinatura TypeScript curta do schema (`navigate(url: string, new_tab?: boolean)`), para o erro de argumento. */
export function toolSignature(tool: ChatTool): string {
	const required = new Set(tool.function.parameters.required ?? []);
	const params = Object.entries(tool.function.parameters.properties ?? {}).map(([key, schema]) => `${key}${required.has(key) ? "" : "?"}: ${typeOf(schema)}`);
	const signature = `${tool.function.name}(${params.join(", ")})`;
	return signature.length > 400 ? `${signature.slice(0, 397)}...` : signature;
}

/** Campos obrigatórios do schema ausentes nos args (só presença; o executor valida tipo e valor). */
export function missingRequiredArgs(tool: ChatTool, args: Record<string, unknown>): string[] {
	return (tool.function.parameters.required ?? []).filter((key) => args[key] === undefined || args[key] === null);
}

/**
 * Campos que o schema não declara (regra do dono: campo desconhecido falha com a lista do que é aceito, nunca é
 * descartado em silêncio). Só vale quando o schema lista propriedades e não abre `additionalProperties`.
 */
export function unknownArgs(tool: ChatTool, args: Record<string, unknown>): string[] {
	const parameters = tool.function.parameters as { properties?: Record<string, unknown>; additionalProperties?: unknown };
	const properties = parameters.properties ?? {};
	if (Object.keys(properties).length === 0 || parameters.additionalProperties === true || typeof parameters.additionalProperties === "object") return [];
	return Object.keys(args).filter((key) => !Object.hasOwn(properties, key));
}

export function unknownArgsMessage(tool: ChatTool, unknown: readonly string[]): string {
	const accepted = Object.keys(tool.function.parameters.properties ?? {}).slice(0, 12).join(", ");
	return invalidArgsMessage(tool, `unknown field${unknown.length > 1 ? "s" : ""} ${unknown.slice(0, 5).join(", ")} (accepted: ${accepted})`);
}

export function invalidArgsMessage(tool: ChatTool, reason: string): string {
	return `Invalid arguments: ${reason.slice(0, 300)}. Expected: ${toolSignature(tool)}. Call it again with valid JSON arguments.`;
}

export type TransportOptions = {
	model: string;
	fallbackModels?: readonly string[];
	/** Já saiu texto ao vivo nesta chamada: repetir duplicaria o balão, então não há nova tentativa. */
	delivered: () => boolean;
	sleep?: (ms: number) => Promise<void>;
	delaysMs?: readonly number[];
	signal?: AbortSignal;
	onRetry?: (info: { model: string; attempt: number; error: string }) => void;
};

/** 3 tentativas no total por modelo (2 esperas). */
export const TRANSPORT_DELAYS_MS: readonly number[] = [1_000, 4_000];

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Transporte: até 3 tentativas com backoff para erro transitório no modelo pedido; depois a cadeia de fallback
 * configurada (`fallbackModels`), uma tentativa por modelo. Erro não transitório (chave, política do provedor, 400)
 * sobe na hora. Quem chama registra o modelo servido no span; o chat não anuncia a troca.
 */
export async function withTransportRetry<T>(call: (model: string) => Promise<T>, options: TransportOptions): Promise<T> {
	const sleep = options.sleep ?? defaultSleep;
	const delays = options.delaysMs ?? TRANSPORT_DELAYS_MS;
	let lastError: unknown;
	const chain = [options.model, ...(options.fallbackModels ?? []).filter((model) => model && model !== options.model)];
	for (const [index, model] of chain.entries()) {
		const attempts = index === 0 ? delays.length + 1 : 1;
		for (let attempt = 1; attempt <= attempts; attempt += 1) {
			options.signal?.throwIfAborted();
			try {
				return await call(model);
			} catch (error) {
				lastError = error;
				if (options.signal?.aborted || options.delivered() || !isRetryableLlmError(error)) throw error;
				options.onRetry?.({ model, attempt, error: honestError(error) });
				if (attempt < attempts) await sleep(delays[attempt - 1] ?? 0);
			}
		}
	}
	throw lastError;
}
