import { systemMessages, type AgentRun } from "@workspace/shared";
import { classifyRunError, type BudgetExhaustedError } from "@workspace/agent-runtime";
import { chainFollowUp, followUpRequest, type FollowUpOutcome } from "./follow-up.js";

/**
 * Retomada automática: em vez de pedir "responda continuar", o worker agenda um run de continuação da
 * mesma conversa (parte da transcrição do run parado). Vale só para causas recuperáveis e com limite:
 *  - `steps`: teto de passos atingido com progresso real;
 *  - `transient`: falha do provedor/rede/timeout que esgotou as tentativas da fila.
 * Nunca para decisão do usuário, recusa de permissão, limites de custo/tokens/relógio/contexto, run sem
 * progresso ou quando o limite de retomadas do turno acabou.
 */
export const AUTO_CONTINUE_MAX = 2;
/** Texto de status em pt-BR (padrão); o run usa `systemMessages(idioma).autoContinueStatus`. */
export const AUTO_CONTINUE_STATUS_TEXT = systemMessages("pt-BR").autoContinueStatus;
export const AUTO_CONTINUE_INSTRUCTION =
	"Continue the previous task from where it stopped. Do not repeat steps that are already done and do not ask the user to confirm; use what was already gathered and finish the remaining work.";
/** Espera antes de cada retomada: teto de passos é imediato; falha transitória ganha folga crescente. */
export const AUTO_CONTINUE_DELAY_MS = { steps: 2_000, transient: [20_000, 60_000] } as const;
/** Origens com alguém acompanhando a conversa; rotinas, webhooks e proativos não se estendem sozinhos. */
const AUTO_CONTINUE_ORIGINS: ReadonlySet<string> = new Set(["chat"]);

export type AutoContinueCause = "steps" | "transient";
export type AutoContinueSkip = "not_recoverable" | "exhausted" | "no_progress" | "origin" | "pending_input" | "cost_cap" | "cancelled";
export type AutoContinueDecision =
	| { schedule: true; cause: AutoContinueCause; attempt: number; delayMs: number; maxCostUsd?: number }
	| { schedule: false; reason: AutoContinueSkip };

/** Quantas retomadas automáticas já levaram a este run (0 = run iniciado pelo usuário). */
export function readAutoContinueAttempt(budgetJson: unknown): number {
	const raw = (budgetJson as { autoContinue?: { attempt?: unknown } } | null | undefined)?.autoContinue?.attempt;
	return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : 0;
}

/** Parada por orçamento: só o teto de passos é recuperável (relógio, custo, tokens e contexto são limites). */
export function autoContinueCauseOfBudgetStop(error: Pick<BudgetExhaustedError, "kind">): AutoContinueCause | null {
	return error.kind === "steps" ? "steps" : null;
}

/** Falha do run que a fila já tentou de novo: só a transitória (5xx/429/rede/timeout) merece retomada. */
export function autoContinueCauseOfFailure(error: unknown): AutoContinueCause | null {
	return classifyRunError(error) === "transient" ? "transient" : null;
}

export function decideAutoContinue(input: {
	cause: AutoContinueCause | null;
	origin: string;
	/** Retomadas automáticas que já levaram a este run. */
	attempt: number;
	/** Chamadas de ferramenta bem-sucedidas neste run (0 = nada avançou). */
	progress: number;
	hasPendingInput: boolean;
	cancelRequested?: boolean;
	/** Limite de custo por execução definido pelo usuário/bot e o gasto até a parada. */
	costCapUsd?: number;
	costUsedUsd?: number;
}): AutoContinueDecision {
	if (!input.cause) return { schedule: false, reason: "not_recoverable" };
	if (input.cancelRequested) return { schedule: false, reason: "cancelled" };
	if (!AUTO_CONTINUE_ORIGINS.has(input.origin)) return { schedule: false, reason: "origin" };
	if (input.attempt >= AUTO_CONTINUE_MAX) return { schedule: false, reason: "exhausted" };
	// Entrada do usuário pendente vira o próximo turno por conta própria.
	if (input.hasPendingInput) return { schedule: false, reason: "pending_input" };
	if (input.progress <= 0) return { schedule: false, reason: "no_progress" };
	let maxCostUsd: number | undefined;
	if (input.costCapUsd !== undefined && input.costCapUsd > 0) {
		const left = input.costCapUsd - (input.costUsedUsd ?? 0);
		if (!(left > 0)) return { schedule: false, reason: "cost_cap" };
		maxCostUsd = left;
	}
	const delayMs = input.cause === "steps" ? AUTO_CONTINUE_DELAY_MS.steps : AUTO_CONTINUE_DELAY_MS.transient[Math.min(input.attempt, AUTO_CONTINUE_DELAY_MS.transient.length - 1)]!;
	return { schedule: true, cause: input.cause, attempt: input.attempt + 1, delayMs, ...(maxCostUsd !== undefined ? { maxCostUsd } : {}) };
}

/** Orçamento gravado no run de continuação: contador do turno e, se havia limite de custo, só o que sobrou dele. */
export function continuationBudget(decision: Extract<AutoContinueDecision, { schedule: true }>): NonNullable<Parameters<typeof followUpRequest>[0]["budget"]> {
	return { autoContinue: { attempt: decision.attempt }, ...(decision.maxCostUsd !== undefined ? { maxCostUsd: decision.maxCostUsd } : {}) };
}

export type AutoContinueIo = {
	hasPendingInput: (runId: string) => Promise<boolean>;
	countProgress: (runId: string) => Promise<number>;
	/** Entrada `queue` do run parado, com chave estável (reentrega não duplica). */
	addInput: (runId: string, userId: string, content: string, clientKey: string) => Promise<void>;
	/** Cria o run de continuação a partir da entrada e o enfileira com a espera. */
	chain: (run: AgentRun, userId: string, decision: Extract<AutoContinueDecision, { schedule: true }>) => Promise<FollowUpOutcome>;
};

/** Decide e, quando cabe, devolve o plano. Lê o banco só depois das barreiras baratas. */
export async function planAutoContinue(
	run: Pick<AgentRun, "id" | "origin" | "budgetJson" | "cancelRequested">,
	input: { cause: AutoContinueCause | null; costUsedUsd?: number; costCapUsd?: number; progress?: number },
	io: Pick<AutoContinueIo, "hasPendingInput" | "countProgress">,
): Promise<AutoContinueDecision> {
	const attempt = readAutoContinueAttempt(run.budgetJson);
	const early = decideAutoContinue({ cause: input.cause, origin: run.origin, attempt, progress: 1, hasPendingInput: false, cancelRequested: run.cancelRequested });
	if (!early.schedule) return early;
	const [hasPendingInput, progress] = await Promise.all([io.hasPendingInput(run.id), input.progress !== undefined ? Promise.resolve(input.progress) : io.countProgress(run.id)]);
	return decideAutoContinue({ cause: input.cause, origin: run.origin, attempt, progress, hasPendingInput, cancelRequested: run.cancelRequested, costCapUsd: input.costCapUsd, costUsedUsd: input.costUsedUsd });
}

/** Grava a entrada e encadeia o run de continuação. Idempotente por run; nunca lança. */
export async function scheduleAutoContinue(
	run: AgentRun,
	userId: string,
	decision: Extract<AutoContinueDecision, { schedule: true }>,
	io: Pick<AutoContinueIo, "addInput" | "chain">,
): Promise<FollowUpOutcome> {
	try {
		await io.addInput(run.id, userId, AUTO_CONTINUE_INSTRUCTION, `auto-continue:${run.id}`);
		return await io.chain(run, userId, decision);
	} catch (error) {
		console.error(`auto-continue failed run=${run.id}`, error);
		return "none";
	}
}

/** A retomada saiu do papel (ou foi recusada pela fila): quem fechava o run precisa do fechamento comum. */
export function autoContinueScheduled(outcome: FollowUpOutcome): boolean {
	return outcome === "created" || outcome === "enqueue_failed";
}
