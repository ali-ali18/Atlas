/**
 * Inspetor do run ("o que o modelo viu"). Só metadados: contagens estimadas de tokens por categoria,
 * nomes de tools, ações de higiene e status de chamadas. O texto do prompt só existe no passo quando a
 * flag `ATLAS_RUN_INSPECTOR_FULL=1` está ligada (já redigido). Funções puras (sem I/O).
 */

import { lessonRef, parseLessonFeedback, type InspectHooksPayload, type InspectLessonsPayload, type LessonFeedbackOutcome } from "./lessons.js";
import { PLAN_OUTCOME_ADJUSTED, PLAN_OUTCOME_APPROVED } from "./plan.js";
import { readRunCaps } from "./engine-policy.js";
import { describeRunStop } from "./run-stop-reason.js";

export const INSPECT_CATEGORIES = ["system", "tools", "history", "toolResults", "notes", "turn"] as const;
export type InspectCategory = (typeof INSPECT_CATEGORIES)[number];

export type InspectActionKind = "collapsed" | "trimmed" | "summary" | "summary_failed" | "compaction" | "guard" | "compact";

export type InspectAction = {
	kind: InspectActionKind;
	/** Quantidade (grupos colapsados, mensagens cortadas) ou tokens antes/depois quando houver. */
	count?: number;
	before?: number;
	after?: number;
	detail?: string;
};

/** Gravado em `AgentStep.outputJson.inspect` do passo do modelo. */
export type StepInspect = {
	v: 1;
	/** Tokens estimados (chars/4) do que foi enviado, por categoria. */
	tokens: Record<InspectCategory, number>;
	total: number;
	messages: number;
	contextLength?: number;
	tools: {
		count: number;
		/** Lista completa só quando mudou desde o passo anterior (1º passo sempre). */
		names?: string[];
		added?: string[];
		removed?: string[];
	};
	actions: InspectAction[];
	/** Pedido serializado e redigido; só com a flag de inspeção completa. */
	request?: { text: string; truncated?: boolean };
};

export type InspectTranscriptMode = "carried" | "seed" | "fallback" | "first_turn" | "off";

/** Evento `inspect_context` do run: como o histórico foi montado. */
export type InspectContextPayload = {
	type: "inspect_context";
	transcript: { mode: InspectTranscriptMode; reason?: string; priorMessages?: number; loadedTools?: number };
};

export type InspectStepView = {
	decisionIndex: number;
	model?: string;
	requestedModel?: string;
	provider?: string;
	durationMs?: number;
	/** Tempo até o primeiro chunk do stream (ms). */
	ttftMs?: number;
	finishReason?: string;
	promptTokens?: number;
	completionTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUsd?: number;
	tokens?: Record<InspectCategory, number>;
	estimatedTotal?: number;
	contextLength?: number;
	messages?: number;
	toolCount?: number;
	/** Tools disponíveis neste passo (reconstruídas dos deltas). */
	toolNames?: string[];
	actions: InspectAction[];
	retries?: number;
	retryReasons?: string[];
	hasRequest: boolean;
	request?: { text: string; truncated?: boolean };
};

export type InspectToolCall = {
	id: string;
	name: string;
	/** Argumentos em JSON, truncados. */
	args?: string;
	status: "ok" | "failed" | "running" | "uncertain";
	durationMs?: number;
	decisionIndex: number;
	summary?: string;
	/** Decisão da política antes de executar; só aparece quando não foi o caminho normal (`allow`). */
	policyDecision?: "confirm" | "blocked";
};

export type InspectApproval = {
	id: string;
	title: string;
	status: "pending" | "approved" | "rejected" | "failed";
	detail?: string;
	ok?: boolean;
	/** Cartão de plano (`propose_plan`): proposto, aprovado, ajustado (o usuário pediu mudança) ou cancelado. */
	plan?: { steps: number; state: "proposed" | "approved" | "adjusted" | "cancelled" };
};

/** Hooks do run: acertos do portão do plano e das regras das lições (só metadados). */
export type InspectHooks = {
	hits: Array<{ source: "plan" | "rule"; action: "blocked" | "confirm" | "skipped"; tool: string; ref?: string; ruleKind?: string; detail?: string }>;
	/** Refs (L1a2b) das lições cuja regra barrou uma chamada que depois deu certo. */
	helped: string[];
};

/** Lições (playbook do bot) neste run: o que foi injetado, o que o modelo marcou como usado e a última revisão em segundo plano. */
export type InspectLessons = {
	/** Ids curtos (L1a2b) das lições injetadas, sem repetição, na ordem em que entraram. */
	injected: string[];
	atStart: number;
	/** Lições de conector/tool que entraram depois, ao carregar o conector (chave → ids curtos). */
	loaded: Array<{ key: string; refs: string[] }>;
	/** Marcadas pelo modelo com `lesson_feedback`. */
	used: Array<{ ref: string; outcome: LessonFeedbackOutcome }>;
	/** Resultado da revisão de lições do run anterior (job em segundo plano), mostrado como ação neste run. */
	review?: NonNullable<InspectLessonsPayload["review"]>;
};

export type RunInspection = {
	v: 1;
	runId: string;
	status: string;
	model: string;
	origin: string;
	error?: string;
	/** Por que o run terminou, em pt-BR simples (ex.: "Teto de gasto configurado (US$ 0,25 · servidor)"). Ausente em resposta normal. */
	stop?: { reason: string; detail?: string; label: string };
	fullRequestEnabled: boolean;
	context?: InspectContextPayload["transcript"];
	lessons?: InspectLessons;
	hooks?: InspectHooks;
	steps: InspectStepView[];
	toolCalls: InspectToolCall[];
	approvals: InspectApproval[];
	errors: Array<{ message: string; at?: string }>;
	totals: { steps: number; toolCalls: number; failedToolCalls: number; promptTokens: number; completionTokens: number; cacheReadTokens?: number; costUsd?: number };
};

export type InspectRawStep = {
	index: number;
	decisionIndex: number;
	subIndex: number;
	type: string;
	status: string;
	inputJson: unknown;
	outputJson: unknown;
	tokens?: number | null;
	costUsd?: number | null;
	durationMs?: number | null;
	idempotencyKey?: string | null;
	/** Colunas de span (PR3c); nulas em passo antigo, que cai na telemetria do `outputJson`. */
	kind?: string | null;
	provider?: string | null;
	model?: string | null;
	cachedTokens?: number | null;
	outputTokens?: number | null;
	ttftMs?: number | null;
	finishReason?: string | null;
	policyDecision?: string | null;
};

export type InspectRawEvent = { seq: number; type: string; payload: unknown; createdAt?: string };
export type InspectRawApproval = { id: string; content: string };

export const INSPECT_ARGS_MAX = 400;
export const INSPECT_SUMMARY_MAX = 300;
export const INSPECT_ERRORS_MAX = 10;
export const INSPECT_HOOK_HITS_MAX = 30;

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function strings(input: unknown): string[] | undefined {
	return Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : undefined;
}

function emptyTokens(): Record<InspectCategory, number> {
	return { system: 0, tools: 0, history: 0, toolResults: 0, notes: 0, turn: 0 };
}

function parseInspect(raw: unknown): StepInspect | undefined {
	const value = record(raw);
	const tokens = record(value?.tokens);
	if (!value || !tokens) return undefined;
	const out = emptyTokens();
	for (const key of INSPECT_CATEGORIES) out[key] = Math.max(0, num(tokens[key]) ?? 0);
	const tools = record(value.tools);
	const request = record(value.request);
	const actions: InspectAction[] = [];
	if (Array.isArray(value.actions)) {
		for (const item of value.actions) {
			const action = record(item);
			const kind = str(action?.kind) as InspectActionKind | undefined;
			if (!action || !kind) continue;
			actions.push({
				kind,
				...(num(action.count) !== undefined ? { count: num(action.count) } : {}),
				...(num(action.before) !== undefined ? { before: num(action.before) } : {}),
				...(num(action.after) !== undefined ? { after: num(action.after) } : {}),
				...(str(action.detail) ? { detail: str(action.detail) } : {}),
			});
		}
	}
	return {
		v: 1,
		tokens: out,
		total: num(value.total) ?? INSPECT_CATEGORIES.reduce((sum, key) => sum + out[key], 0),
		messages: num(value.messages) ?? 0,
		...(num(value.contextLength) !== undefined ? { contextLength: num(value.contextLength) } : {}),
		tools: {
			count: num(tools?.count) ?? 0,
			...(strings(tools?.names) ? { names: strings(tools?.names) } : {}),
			...(strings(tools?.added) ? { added: strings(tools?.added) } : {}),
			...(strings(tools?.removed) ? { removed: strings(tools?.removed) } : {}),
		},
		actions,
		...(request && str(request.text) ? { request: { text: str(request.text)!, ...(request.truncated === true ? { truncated: true } : {}) } } : {}),
	};
}

function parseApproval(row: InspectRawApproval): InspectApproval | null {
	try {
		const card = record(JSON.parse(row.content));
		if (!card || card.kind !== "confirm") return null;
		const status = card.status;
		if (status !== "pending" && status !== "approved" && status !== "rejected" && status !== "failed") return null;
		const outcome = record(card.outcome);
		const planCard = record(card.plan);
		const planSteps = Array.isArray(planCard?.steps) ? planCard.steps.length : 0;
		const detailText = str(outcome?.detail);
		const planState: NonNullable<InspectApproval["plan"]>["state"] | undefined = !planCard
			? undefined
			: status === "approved" || detailText === PLAN_OUTCOME_APPROVED
				? "approved"
				: detailText === PLAN_OUTCOME_ADJUSTED
					? "adjusted"
					: status === "pending"
						? "proposed"
						: "cancelled";
		return {
			...(planState ? { plan: { steps: planSteps, state: planState } } : {}),
			id: str(card.confirmId) ?? row.id,
			title: clip(str(card.title) ?? "", 200),
			status,
			...(str(outcome?.detail) ? { detail: clip(str(outcome?.detail)!, INSPECT_SUMMARY_MAX) } : {}),
			...(typeof outcome?.ok === "boolean" ? { ok: outcome.ok } : {}),
		};
	} catch {
		return null;
	}
}

/**
 * Monta a visão do inspetor a partir das linhas do banco. O dono já foi verificado pelo chamador.
 * Tolerante: passos antigos (sem `inspect`) aparecem só com a telemetria que tiverem.
 */
export function buildRunInspection(input: {
	run: { id: string; status: string; model: string; origin: string; error?: string | null; stopReason?: string | null; stopDetail?: string | null; budgetJson?: unknown };
	steps: readonly InspectRawStep[];
	events: readonly InspectRawEvent[];
	approvals: readonly InspectRawApproval[];
	fullRequestEnabled?: boolean;
	scrub?: (text: string) => string;
}): RunInspection {
	const scrub = input.scrub ?? ((text: string) => text);
	const ordered = [...input.steps].sort((a, b) => a.decisionIndex - b.decisionIndex || a.subIndex - b.subIndex);
	const steps: InspectStepView[] = [];
	const toolCalls: InspectToolCall[] = [];
	let currentTools: string[] = [];
	const used: InspectLessons["used"] = [];
	let prompt = 0;
	let completion = 0;
	let cacheRead: number | undefined;
	let cost: number | undefined;

	for (const step of ordered) {
		const output = record(step.outputJson);
		const telemetry = record(output?.telemetry);
		if (step.type === "model") {
			const inspect = parseInspect(output?.inspect);
			if (inspect) {
				if (inspect.tools.names) currentTools = [...inspect.tools.names];
				else {
					if (inspect.tools.removed?.length) currentTools = currentTools.filter((name) => !inspect.tools.removed!.includes(name));
					if (inspect.tools.added?.length) currentTools = [...currentTools, ...inspect.tools.added.filter((name) => !currentTools.includes(name))];
				}
			}
			// Colunas do span primeiro; passo anterior ao PR3c só tem a telemetria no `outputJson`.
			const promptTokens = num(telemetry?.promptTokens);
			const completionTokens = num(step.outputTokens) ?? num(telemetry?.completionTokens);
			const cacheReadTokens = num(step.cachedTokens) ?? num(telemetry?.cachedTokens);
			const ttftMs = num(step.ttftMs) ?? num(telemetry?.ttftMs);
			const finishReason = str(step.finishReason) ?? str(output?.finishReason);
			const spanProvider = str(step.provider) ?? str(telemetry?.provider);
			const spanModel = str(step.model) ?? str(telemetry?.servedModel);
			prompt += promptTokens ?? 0;
			completion += completionTokens ?? 0;
			if (cacheReadTokens !== undefined) cacheRead = (cacheRead ?? 0) + cacheReadTokens;
			const stepCost = num(step.costUsd) ?? num(telemetry?.costUsd);
			if (stepCost !== undefined) cost = (cost ?? 0) + stepCost;
			const attempts = num(telemetry?.llmAttempts);
			steps.push({
				decisionIndex: step.decisionIndex,
				...(spanModel ? { model: spanModel } : {}),
				...(str(telemetry?.requestedModel) ? { requestedModel: str(telemetry?.requestedModel) } : {}),
				...(spanProvider ? { provider: spanProvider } : {}),
				...(num(step.durationMs) !== undefined ? { durationMs: num(step.durationMs) } : {}),
				...(ttftMs !== undefined ? { ttftMs } : {}),
				...(finishReason ? { finishReason } : {}),
				...(promptTokens !== undefined ? { promptTokens } : {}),
				...(completionTokens !== undefined ? { completionTokens } : {}),
				...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
				...(num(telemetry?.cacheWriteTokens) !== undefined ? { cacheWriteTokens: num(telemetry?.cacheWriteTokens) } : {}),
				...(stepCost !== undefined ? { costUsd: stepCost } : {}),
				...(inspect ? { tokens: inspect.tokens, estimatedTotal: inspect.total, messages: inspect.messages, toolCount: inspect.tools.count, toolNames: [...currentTools] } : {}),
				...(inspect?.contextLength !== undefined ? { contextLength: inspect.contextLength } : {}),
				actions: inspect?.actions ?? [],
				...(attempts !== undefined && attempts > 1 ? { retries: attempts - 1 } : {}),
				...(strings(telemetry?.retryReasons)?.length ? { retryReasons: strings(telemetry?.retryReasons)!.slice(0, 10) } : {}),
				hasRequest: Boolean(inspect?.request),
				// O pedido completo já foi redigido ao gravar (o filtro de texto curto o truncaria).
				...(inspect?.request ? { request: inspect.request } : {}),
			});
			continue;
		}
		if (step.type === "tool" || step.type === "tool_result") {
			const inputJson = record(step.inputJson);
			const name = str(inputJson?.name) ?? str(telemetry?.toolName);
			if (!name || name === "context_summary") continue;
			let args: string | undefined;
			if (inputJson && "args" in inputJson) {
				try {
					args = clip(scrub(typeof inputJson.args === "string" ? inputJson.args : JSON.stringify(inputJson.args)), INSPECT_ARGS_MAX);
				} catch {
					args = undefined;
				}
			}
			const status = record(output?.status);
			const uncertain = status?.uncertain === true;
			const failed = step.status === "failed" || output?.ok === false;
			const policy = str(step.policyDecision) ?? str(telemetry?.policyDecision);
			if (name === "lesson_feedback" && step.type === "tool_result" && !failed) {
				let rawArgs: unknown = inputJson?.args;
				if (typeof rawArgs === "string") {
					try {
						rawArgs = JSON.parse(rawArgs);
					} catch {
						rawArgs = undefined;
					}
				}
				for (const entry of parseLessonFeedback(record(rawArgs) ?? {})) used.push({ ref: entry.ref.replace(/^\[|\]$/g, ""), outcome: entry.outcome });
			}
			toolCalls.push({
				id: step.idempotencyKey ?? `${step.decisionIndex}:${step.subIndex}`,
				name,
				...(args ? { args } : {}),
				status: step.type === "tool" ? "running" : uncertain ? "uncertain" : failed ? "failed" : "ok",
				...(num(step.durationMs) !== undefined ? { durationMs: num(step.durationMs) } : {}),
				decisionIndex: step.decisionIndex,
				...(policy === "confirm" || policy === "blocked" ? { policyDecision: policy } : {}),
				...(str(output?.summary) ? { summary: clip(scrub(str(output?.summary)!), INSPECT_SUMMARY_MAX) } : {}),
			});
		}
	}

	let context: InspectContextPayload["transcript"] | undefined;
	const lessonIds: string[] = [];
	let lessonsAtStart = 0;
	const lessonsLoaded: InspectLessons["loaded"] = [];
	let lessonReview: InspectLessons["review"];
	const hookHits: InspectHooks["hits"] = [];
	const hookHelped: string[] = [];
	const errors: Array<{ message: string; at?: string }> = [];
	for (const event of input.events) {
		const payload = record(event.payload);
		if (event.type === "inspect_context") {
			const transcript = record(payload?.transcript);
			const mode = str(transcript?.mode) as InspectTranscriptMode | undefined;
			if (mode) {
				context = {
					mode,
					...(str(transcript?.reason) ? { reason: str(transcript?.reason) } : {}),
					...(num(transcript?.priorMessages) !== undefined ? { priorMessages: num(transcript?.priorMessages) } : {}),
					...(num(transcript?.loadedTools) !== undefined ? { loadedTools: num(transcript?.loadedTools) } : {}),
				};
			}
		} else if (event.type === "inspect_lessons") {
			const ids = strings(payload?.injected) ?? [];
			const key = str(payload?.key);
			const refs = ids.map(lessonRef);
			for (const ref of refs) if (!lessonIds.includes(ref)) lessonIds.push(ref);
			if (key) lessonsLoaded.push({ key: clip(key, 120), refs });
			else lessonsAtStart += refs.length;
			const review = record(payload?.review);
			if (review && str(review.status) && str(review.runId)) {
				lessonReview = {
					runId: str(review.runId)!,
					at: str(review.at) ?? "",
					status: str(review.status)!,
					...(num(review.added) !== undefined ? { added: num(review.added) } : {}),
					...(num(review.updated) !== undefined ? { updated: num(review.updated) } : {}),
					...(num(review.retired) !== undefined ? { retired: num(review.retired) } : {}),
					...(num(review.counters) !== undefined ? { counters: num(review.counters) } : {}),
					...(num(review.rejected) !== undefined ? { rejected: num(review.rejected) } : {}),
					...(review.skillProposal === true ? { skillProposal: true } : {}),
					...(strings(review.signals) ? { signals: strings(review.signals)!.slice(0, 6) } : {}),
				};
			}
		} else if (event.type === "inspect_hooks") {
			const hooks = payload as Partial<InspectHooksPayload> | undefined;
			for (const hit of Array.isArray(hooks?.hits) ? hooks.hits : []) {
				const row = record(hit);
				const source = row?.source === "plan" || row?.source === "rule" ? row.source : undefined;
				const action = row?.action === "blocked" || row?.action === "confirm" || row?.action === "skipped" ? row.action : undefined;
				if (!row || !source || !action || !str(row.tool) || hookHits.length >= INSPECT_HOOK_HITS_MAX) continue;
				hookHits.push({
					source,
					action,
					tool: clip(str(row.tool)!, 120),
					...(str(row.lessonId) ? { ref: lessonRef(str(row.lessonId)!) } : {}),
					...(str(row.ruleKind) ? { ruleKind: clip(str(row.ruleKind)!, 40) } : {}),
					...(str(row.detail) ? { detail: clip(scrub(str(row.detail)!), 160) } : {}),
				});
			}
			for (const id of strings(hooks?.helped) ?? []) {
				const ref = lessonRef(id);
				if (!hookHelped.includes(ref)) hookHelped.push(ref);
			}
		} else if (event.type === "error") {
			const message = str(payload?.error);
			if (message && errors.length < INSPECT_ERRORS_MAX) errors.push({ message: clip(scrub(message), INSPECT_SUMMARY_MAX), ...(event.createdAt ? { at: event.createdAt } : {}) });
		}
	}

	return {
		v: 1,
		runId: input.run.id,
		status: input.run.status,
		model: input.run.model,
		origin: input.run.origin,
		...(input.run.error ? { error: clip(scrub(input.run.error), INSPECT_SUMMARY_MAX) } : {}),
		...(() => {
			const label = describeRunStop({ reason: input.run.stopReason, detail: input.run.stopDetail }, readRunCaps(input.run.budgetJson));
			return label && input.run.stopReason ? { stop: { reason: input.run.stopReason, ...(input.run.stopDetail ? { detail: input.run.stopDetail } : {}), label } } : {};
		})(),
		fullRequestEnabled: input.fullRequestEnabled ?? steps.some((item) => item.hasRequest),
		...(context ? { context } : {}),
		...(lessonIds.length > 0 || used.length > 0 || lessonReview
			? { lessons: { injected: lessonIds, atStart: lessonsAtStart, loaded: lessonsLoaded, used, ...(lessonReview ? { review: lessonReview } : {}) } }
			: {}),
		...(hookHits.length > 0 || hookHelped.length > 0 ? { hooks: { hits: hookHits, helped: hookHelped } } : {}),
		steps,
		toolCalls,
		approvals: input.approvals.map(parseApproval).filter((item): item is InspectApproval => item !== null),
		errors,
		totals: {
			steps: steps.length,
			toolCalls: toolCalls.length,
			failedToolCalls: toolCalls.filter((call) => call.status === "failed").length,
			promptTokens: prompt,
			completionTokens: completion,
			...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
			...(cost !== undefined ? { costUsd: cost } : {}),
		},
	};
}
