import { providerFailureKind, type ProviderApiError } from "@workspace/llm";
import type { RunUsage } from "@workspace/shared";

export class AgentRunCancelledError extends Error {
	readonly code = "cancelled" as const;

	constructor(message = "Execução cancelada") {
		super(message);
		this.name = "AgentRunCancelledError";
	}
}

/** Interrupção cooperativa: o checkpoint fica preservado para o mesmo run. */
export class AgentRunPausedError extends Error {
	readonly code = "paused" as const;

	constructor(message = "Execução pausada") {
		super(message);
		this.name = "AgentRunPausedError";
	}
}

export class LeaseLostError extends Error {
	readonly code = "lease_lost" as const;
	readonly transient = true as const;

	constructor(message = "Lease perdido; outro worker assumiu o run") {
		super(message);
		this.name = "LeaseLostError";
	}
}

/**
 * Por que o run parou por orçamento. Só `steps` (teto de passos com progresso) é recuperável sozinho;
 * relógio, custo, tokens e janela de contexto são limites do usuário/modelo e nunca retomam automaticamente.
 */
export type BudgetStopKind = "steps" | "stalled" | "wall" | "cost" | "tokens" | "context" | "other";

export class BudgetExhaustedError extends Error {
	readonly code = "budget_exhausted" as const;
	/** Resumo final ao usuário (chamada sem tools), quando gerado. */
	finalText?: string;
	/** Uso até a parada (inclui `computer`), para o worker gravar em `usageJson`. */
	usage?: RunUsage;
	/** Ferramentas que terminaram com sucesso neste run (progresso real); preenchido ao fechar o run. */
	okToolCalls?: number;
	/** O fechamento foi adiado porque o worker vai retomar sozinho (sem resumo nem "responda continuar"). */
	deferredClosing?: boolean;

	constructor(message = "Orçamento do run esgotado", readonly kind: BudgetStopKind = "other") {
		super(message);
		this.name = "BudgetExhaustedError";
	}
}

/** O modelo repetiu a mesma ação sem progresso: parar é melhor que o muro. */
export class AgentRunLoopDetectedError extends Error {
	readonly code = "loop_detected" as const;
	/** Resumo final ao usuário (chamada sem tools), quando gerado. */
	finalText?: string;
	/** Uso até a parada (inclui `computer`), para o worker gravar em `usageJson`. */
	usage?: RunUsage;

	constructor(message: string) {
		super(message);
		this.name = "AgentRunLoopDetectedError";
	}
}

export class PermanentRunError extends Error {
	readonly code = "permanent" as const;

	constructor(message: string) {
		super(message);
		this.name = "PermanentRunError";
	}
}

export class TransientRunError extends Error {
	readonly code = "transient" as const;
	readonly transient = true as const;

	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "TransientRunError";
	}
}

export type ClassifiedRunError =
	| "paused"
	| "cancelled"
	| "transient"
	| "permanent"
	| "waiting_user"
	| "budget_exhausted"
	| "lease_lost";

const TRANSIENT_PATTERNS = [
	/econnreset/i,
	/etimedout/i,
	/econnrefused/i,
	/socket hang up/i,
	/fetch failed/i,
	/\bnetwork (?:error|request|connection|is unreachable)\b/i,
	// Código HTTP só com prefixo ("HTTP 503", "status 429") ou no início: número solto no texto não conta.
	/(?:^|\b(?:http|status(?: code)?|error)[ :=]*)(?:429|50[0234])\b/i,
	/rate[- ]?limit/i,
	/retry shortly/i,
	/\btry again (?:later|shortly|in)\b/i,
	/could not verify/i,
	/\btemporar(?:y|ily)\b/i,
	/\b(?:service|temporarily) unavailable\b/i,
	/\bstalled\b/i,
	/\bredis\b/i,
	/failed to start sandbox/i,
	/did not become ready/i,
	/chrome indispon/i,
	/perfil do chrome/i,
	/control server/i,
];

function walkErrorChain(error: unknown): unknown[] {
	const chain: unknown[] = [];
	let current: unknown = error;
	for (let i = 0; i < 8 && current !== undefined && current !== null; i += 1) {
		chain.push(current);
		if (current instanceof Error && current.cause !== undefined) {
			current = current.cause;
			continue;
		}
		break;
	}
	return chain;
}

function isTimeoutLike(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const name = "name" in value ? String(value.name) : "";
	const message = "message" in value ? String(value.message) : "";
	return (
		name === "TimeoutError" || /aborted due to timeout/i.test(message)
	);
}

function isAbortLike(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const name = "name" in value ? String(value.name) : "";
	return name === "AbortError" || name === "DOMException";
}

/** Converte o motivo de um AbortSignal no erro de domínio correspondente. */
export function errorFromAbortSignal(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof AgentRunCancelledError) return reason;
	if (reason instanceof LeaseLostError) return reason;
	if (reason instanceof BudgetExhaustedError) return reason;
	if (reason instanceof AgentRunPausedError) return reason;
	if (isTimeoutLike(reason)) {
		const timeout = new Error(
			reason instanceof Error
				? reason.message
				: "The operation was aborted due to timeout",
		);
		timeout.name = "TimeoutError";
		return timeout;
	}
	if (reason instanceof Error) return reason;
	if (isAbortLike(reason)) {
		const abort = new Error(
			reason instanceof Error ? reason.message : "Aborted",
		);
		abort.name = "AbortError";
		return abort;
	}
	const abort = new Error("Aborted");
	abort.name = "AbortError";
	return abort;
}

export function classifyRunError(error: unknown): ClassifiedRunError {
	if (error instanceof AgentRunPausedError) return "paused";
	if (error instanceof AgentRunCancelledError) return "cancelled";
	if (error instanceof BudgetExhaustedError) return "budget_exhausted";
	if (error instanceof AgentRunLoopDetectedError) return "permanent";
	if (error instanceof LeaseLostError) return "lease_lost";
	if (error instanceof PermanentRunError) return "permanent";
	if (error instanceof TransientRunError) return "transient";

	const chain = walkErrorChain(error);
	for (const item of chain) {
		if (item instanceof AgentRunCancelledError) return "cancelled";
		if (item instanceof LeaseLostError) return "lease_lost";
		if (item instanceof BudgetExhaustedError) return "budget_exhausted";
		if (item instanceof AgentRunPausedError) return "paused";
		if (isTimeoutLike(item)) return "transient";
	}

	// Falha de provedor (chave/API): o adaptador e o fallback já tentaram de novo e trocaram de
	// modelo; só plano/chave/requisição ruim terminam o run. O texto traz "429"/"503", que casaria com os padrões abaixo e reenfileiraria o run
	// em silêncio ("começando" para sempre); aqui o run termina com a mensagem do provedor.
	for (const item of chain) {
		if (!(item instanceof Error)) continue;
		if (item.name === "NoFallbackModelError") return "permanent";
		if (item.name === "ProviderApiError") {
			// Plano/chave/requisição recusada não melhora tentando de novo; indisponibilidade do upstream sim (limitada pelos attempts da fila).
			const kind = providerFailureKind(item as ProviderApiError);
			return kind === "upstream" ? "transient" : "permanent";
		}
	}

	// Status HTTP estruturado (OpenRouterError e afins) antes de olhar o texto.
	for (const item of chain) {
		const status = (item as { status?: unknown } | null)?.status;
		if (typeof status !== "number") continue;
		if (status === 429 || status === 408 || (status >= 500 && status < 600)) return "transient";
		if (status >= 400 && status < 500) return "permanent";
	}

	const message = error instanceof Error ? error.message : String(error);

	// AbortError nativo sem motivo de usuário: congestionamento/corte do fetch,
	// nunca cancelamento. Quem aborta por cancel passa AgentRunCancelledError.
	for (const item of chain) {
		if (isAbortLike(item)) return "transient";
	}

	if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(message))) {
		return "transient";
	}
	return "permanent";
}

export function isControlFlowError(error: unknown): boolean {
	return (
		error instanceof AgentRunCancelledError ||
		error instanceof LeaseLostError ||
		error instanceof BudgetExhaustedError ||
		error instanceof AgentRunPausedError
	);
}
