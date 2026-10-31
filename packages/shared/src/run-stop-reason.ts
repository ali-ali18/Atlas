/**
 * Por que um run terminou (F0 do ADR 0002: medir antes de redesenhar o motor).
 * Antes disso o motivo só existia como texto livre em `agent_runs.error`. Aqui fica o vocabulário
 * fechado e as funções puras que mapeiam os erros/sinais do runtime para ele. Sem I/O.
 *
 * O valor é gravado como string simples (sem enum no banco): acrescentar um motivo novo não exige migration,
 * e api/worker de versões diferentes convivem durante o deploy.
 */

export const RUN_STOP_REASONS = [
	/** Resposta normal do modelo, sem nenhuma trava envolvida. */
	"answered",
	/** A estagnação/fechamento forçou a resposta final (tools removidas) e o modelo respondeu. */
	"answered_after_forced_wrap",
	/** O avaliador brando (softEvaluate) disse que o pedido estava concluído no teto de passos. */
	"soft_concluded",
	/** O run parou num cartão que espera o usuário (confirmação, habilidade, questionário, perfil). */
	"awaiting_confirmation",
	/** Pausado esperando login do usuário. */
	"paused_login",
	"budget_steps",
	"budget_stalled",
	"budget_wall",
	"budget_cost",
	"budget_tokens",
	"budget_context",
	/** Mesma ação repetida sem progresso (inclui loop de resultados sem novidade). */
	"loop_repeat",
	/** Enrolação (leitura sem produzir o arquivo prometido) abortada pelo stall-guard. */
	"loop_stall_guard",
	/** Falhas de ferramenta seguidas (trava global). */
	"tool_failures",
	/** Resposta do modelo cortada pelo limite de saída, sem conclusão. */
	"truncated",
	/** Sem progresso detectado (juiz de travamento, arquivo prometido nunca criado). */
	"no_progress",
	"cancelled",
	/** Tentativas da fila esgotadas (falha transitória que não passou). */
	"retries_exhausted",
	/** Worker morto: sem heartbeat ou limite de recuperações. */
	"crash_recoveries",
	/** Erro permanente de outra natureza (provedor, configuração, bug). */
	"error",
	"other",
] as const;

export type RunStopReason = (typeof RUN_STOP_REASONS)[number];

const REASON_SET: ReadonlySet<string> = new Set(RUN_STOP_REASONS);

export function isRunStopReason(value: unknown): value is RunStopReason {
	return typeof value === "string" && REASON_SET.has(value);
}

/** Mesmo vocabulário de `BudgetStopKind` (agent-runtime); duplicado aqui para o shared não depender do runtime. */
export type BudgetKindLike = "steps" | "stalled" | "wall" | "cost" | "tokens" | "context" | "other";

export function stopReasonOfBudget(kind: BudgetKindLike | undefined): RunStopReason {
	switch (kind) {
		case "steps":
			return "budget_steps";
		case "stalled":
			return "budget_stalled";
		case "wall":
			return "budget_wall";
		case "cost":
			return "budget_cost";
		case "tokens":
			return "budget_tokens";
		case "context":
			return "budget_context";
		default:
			return "other";
	}
}

/** Qual trava de loop do runtime abortou o run (`AgentRunLoopDetectedError.kind`). */
export type LoopStopKind = "repeat" | "stall_guard" | "tool_failures" | "truncated" | "no_progress";

export function stopReasonOfLoop(kind: LoopStopKind | undefined): RunStopReason {
	switch (kind) {
		case "repeat":
			return "loop_repeat";
		case "stall_guard":
			return "loop_stall_guard";
		case "tool_failures":
			return "tool_failures";
		case "truncated":
			return "truncated";
		case "no_progress":
			return "no_progress";
		default:
			// Erro de loop sem classificação (versão antiga do runtime): o mais próximo é repetição.
			return "loop_repeat";
	}
}

/** Cartão em que o run parou esperando o usuário. */
export type AwaitingKind = "confirm" | "skill_card" | "questionnaire" | "profile";

/** Sinais internos do loop do runtime que não viram erro nem evento: o runtime os preenche e devolve no resultado. */
export type RunEndSignals = {
	/** A estagnação (ou o juiz de travamento) tirou as tools para forçar a resposta final. */
	forcedWrap?: boolean;
	/** Causa do fechamento forçado (`stuck`, `stagnation`, `orchestrator`), curta e fixa. */
	forcedWrapCause?: string;
	/** O avaliador brando concluiu o pedido no teto de passos. */
	softConcluded?: boolean;
	/** O run parou num cartão que espera o usuário. */
	awaiting?: AwaitingKind;
};

export type RunStop = { reason: RunStopReason; detail?: string };

/** Motivo de um run que o runtime devolveu (não lançou erro): resposta normal ou uma das paradas internas. */
export function stopOfCompletion(signals: RunEndSignals | undefined, opts: { hitWall?: boolean } = {}): RunStop {
	if (opts.hitWall) return { reason: "budget_steps" };
	if (signals?.awaiting) return { reason: "awaiting_confirmation", detail: signals.awaiting };
	if (signals?.softConcluded) return { reason: "soft_concluded" };
	if (signals?.forcedWrap) {
		return { reason: "answered_after_forced_wrap", ...(signals.forcedWrapCause ? { detail: signals.forcedWrapCause } : {}) };
	}
	return { reason: "answered" };
}

export const STOP_DETAIL_MAX = 80;

/**
 * `stopDetail` é um rótulo curto para agrupar (ex.: nome da trava), nunca mensagem de erro: texto de terceiro
 * pode carregar segredo. Mantém só `[a-z0-9_.:-]`, minúsculo, até 80 caracteres; vazio vira `undefined`.
 */
export function sanitizeStopDetail(detail: string | null | undefined): string | undefined {
	if (!detail) return undefined;
	// Corta antes do regex e apara "_" das pontas com laço: `^_+|_+$` fica quadrático em "____…x" (CodeQL).
	const squeezed = detail.slice(0, STOP_DETAIL_MAX * 4).toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_");
	let start = 0;
	let end = squeezed.length;
	while (start < end && squeezed[start] === "_") start += 1;
	while (end > start && squeezed[end - 1] === "_") end -= 1;
	const clean = squeezed.slice(start, end).slice(0, STOP_DETAIL_MAX);
	return clean || undefined;
}

/**
 * Heurística para runs antigos (sem `stopReason`): classifica pelo texto de `error` + status. Serve só para a
 * consulta de medição retroativa; os nomes batem com os de `docs/ops/por-que-runs-terminam.sql`.
 */
export function inferStopReasonFromLegacy(input: { status: string; error?: string | null }): RunStopReason {
	// Só o começo do texto importa para classificar; o corte e os `.{0,120}` limitados mantêm os regex lineares.
	const error = (input.error ?? "").slice(0, 500).toLowerCase();
	if (input.status === "completed") return "answered";
	if (input.status === "cancelled") return "cancelled";
	if (input.status === "paused") return "paused_login";
	if (input.status === "waiting_user") return "awaiting_confirmation";
	if (/sem heartbeat|recuper(?:a|ou) .{0,120}vezes|recoveries/.test(error)) return "crash_recoveries";
	if (/falha ap[oó]s \d+ tentativa/.test(error)) return "retries_exhausted";
	if (input.status === "budget_exhausted" || /limite|teto|or[cç]amento|esgotad/.test(error)) {
		if (/custo|cost|\$/.test(error)) return "budget_cost";
		if (/tempo|rel[oó]gio|wall|minutos/.test(error)) return "budget_wall";
		if (/tokens/.test(error)) return "budget_tokens";
		if (/janela|contexto|context/.test(error)) return "budget_context";
		if (/passos|steps/.test(error)) return "budget_steps";
		if (/sem progresso|estagn|stalled/.test(error)) return "budget_stalled";
		return "other";
	}
	if (/repet|loop|mesm[ao]/.test(error)) return "loop_repeat";
	if (/cortada|truncad/.test(error)) return "truncated";
	if (/falh(?:ou|as) .{0,120}(?:seguid|ferrament)|ferramenta.{0,120}falh/.test(error)) return "tool_failures";
	if (/sem progresso|nenhum arquivo/.test(error)) return "no_progress";
	return input.status === "failed" ? "error" : "other";
}
