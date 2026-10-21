/**
 * Inspetor do run ("o que o modelo viu"). Só metadados: contagens estimadas de tokens por categoria,
 * nomes de tools, ações de higiene e status de chamadas. O texto do prompt só existe no passo quando a
 * flag `ATLAS_RUN_INSPECTOR_FULL=1` está ligada (já redigido). Funções puras (sem I/O).
 */

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
};

export type InspectApproval = {
	id: string;
	title: string;
	status: "pending" | "approved" | "rejected" | "failed";
	detail?: string;
	ok?: boolean;
};

export type RunInspection = {
	v: 1;
	runId: string;
	status: string;
	model: string;
	origin: string;
	error?: string;
	fullRequestEnabled: boolean;
	context?: InspectContextPayload["transcript"];
	steps: InspectStepView[];
	toolCalls: InspectToolCall[];
	approvals: InspectApproval[];
	errors: Array<{ message: string; at?: string }>;
	totals: { steps: number; toolCalls: number; failedToolCalls: number; promptTokens: number; completionTokens: number; costUsd?: number };
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
};

export type InspectRawEvent = { seq: number; type: string; payload: unknown; createdAt?: string };
export type InspectRawApproval = { id: string; content: string };

export const INSPECT_ARGS_MAX = 400;
export const INSPECT_SUMMARY_MAX = 300;
export const INSPECT_ERRORS_MAX = 10;

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
		return {
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
	run: { id: string; status: string; model: string; origin: string; error?: string | null };
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
	let prompt = 0;
	let completion = 0;
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
			const promptTokens = num(telemetry?.promptTokens);
			const completionTokens = num(telemetry?.completionTokens);
			prompt += promptTokens ?? 0;
			completion += completionTokens ?? 0;
			const stepCost = num(step.costUsd) ?? num(telemetry?.costUsd);
			if (stepCost !== undefined) cost = (cost ?? 0) + stepCost;
			const attempts = num(telemetry?.llmAttempts);
			steps.push({
				decisionIndex: step.decisionIndex,
				...(str(telemetry?.servedModel) ? { model: str(telemetry?.servedModel) } : {}),
				...(str(telemetry?.requestedModel) ? { requestedModel: str(telemetry?.requestedModel) } : {}),
				...(str(telemetry?.provider) ? { provider: str(telemetry?.provider) } : {}),
				...(num(step.durationMs) !== undefined ? { durationMs: num(step.durationMs) } : {}),
				...(str(output?.finishReason) ? { finishReason: str(output?.finishReason) } : {}),
				...(promptTokens !== undefined ? { promptTokens } : {}),
				...(completionTokens !== undefined ? { completionTokens } : {}),
				...(num(telemetry?.cachedTokens) !== undefined ? { cacheReadTokens: num(telemetry?.cachedTokens) } : {}),
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
			toolCalls.push({
				id: step.idempotencyKey ?? `${step.decisionIndex}:${step.subIndex}`,
				name,
				...(args ? { args } : {}),
				status: step.type === "tool" ? "running" : uncertain ? "uncertain" : failed ? "failed" : "ok",
				...(num(step.durationMs) !== undefined ? { durationMs: num(step.durationMs) } : {}),
				decisionIndex: step.decisionIndex,
				...(str(output?.summary) ? { summary: clip(scrub(str(output?.summary)!), INSPECT_SUMMARY_MAX) } : {}),
			});
		}
	}

	let context: InspectContextPayload["transcript"] | undefined;
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
		fullRequestEnabled: input.fullRequestEnabled ?? steps.some((item) => item.hasRequest),
		...(context ? { context } : {}),
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
			...(cost !== undefined ? { costUsd: cost } : {}),
		},
	};
}
