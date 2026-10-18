import { cacheHitRatio } from "./prompt-tiers.js";
/**
 * P2/F0 — telemetria de run. Só METADADOS: ids, categorias, tempos, contadores
 * e números de uso. Nunca conteúdo de mensagem, args/resultado de tool, prompt,
 * bytes de imagem nem URL com credencial. Funções puras (sem I/O).
 */

/** Quebra de tempo de um `navigate` (ms): `goto` x espera de prontidão. `textLen` = caracteres legíveis ao fim da espera (0 = SPA ainda vazia). */
export type NavigateTiming = {
	gotoMs?: number;
	readyMs?: number;
	textLen?: number;
};

/** Telemetria de um passo, gravada em `AgentStep.outputJson.telemetry`. */
export type StepTelemetry = {
	v: 1;
	provider?: "openrouter" | "chatgpt" | "anthropic" | "opencode-go";
	costKind?: "plan";
	reasoningTokens?: number;
	fallbackFrom?: string;
	/** Passo do modelo: tempo total da chamada (inclui retries internos). */
	modelMs?: number;
	/** Tempo até o primeiro chunk do stream. */
	ttftMs?: number;
	/** Tool: tempo do executor. */
	toolMs?: number;
	toolName?: string;
	/** Tool `navigate`: onde o tempo foi (V0). Só números; o texto da página nunca entra. */
	nav?: NavigateTiming;
	/** Clique: degrau da escada de alvo que funcionou (preenchido a partir da V1). */
	rung?: string;
	/** Fechamento da decisão: tempo total do passo. */
	stepMs?: number;
	/** Fechamento da decisão: stepMs - modelMs - tempo de parede dos lotes, nunca negativo. */
	overheadMs?: number;
	/** Fechamento da decisão: tempo de parede dos lotes de tools do passo. */
	toolMsTotal?: number;
	requestedModel?: string;
	servedModel?: string;
	/** Tentativas da chamada ao LLM (1 = sem retry). */
	llmAttempts?: number;
	/** Categorias do motivo de cada retry (rate_limit, server_error, ...). */
	retryReasons?: string[];
	promptTokens?: number;
	completionTokens?: number;
	cachedTokens?: number;
	cacheWriteTokens?: number;
	/** Ausente quando o provider não informa (nunca 0 por falta de dado). */
	costUsd?: number;
	/** Id da geração no OpenRouter, para reconciliar o custo depois (só metadado). */
	generationId?: string;
	/** Custo preenchido depois pela reconciliação (não veio na resposta). */
	costReconciled?: true;
};

/** Agregado de decisões Jev do run, contabilizado fora do uso principal. */
export type JevTelemetry = {
	calls: number;
	totalMs: number;
	/** Chamadas com resposta do Jev / sem resposta (timeout, erro, heurística). */
	answered: number;
	unavailable: number;
	inputTokens: number;
	models: string[];
	byFeature: Record<string, { calls: number; totalMs: number }>;
	/** O endpoint de decisões não informa custo: desconhecido, não zero. */
	costUsd: null;
};

/** Metadados de nível de run, gravados em `usageJson.telemetry`. */
export type RunTelemetryMeta = {
	v: 1;
	/** Lease adquirido até a primeira chamada ao modelo. */
	setupMs?: number;
	/** Fim do runtime até antes da gravação final (flush de eventos). */
	postMs?: number;
	/** Modelo pedido ao iniciar e o que respondeu no último passo do modelo (id opaco). */
	requestedModel?: string;
	servedModel?: string;
	jev?: JevTelemetry;
};

export type TelemetryStepLike = {
	type?: string;
	durationMs?: number | null;
	outputJson?: unknown;
};

export function stepTelemetryOf(step: TelemetryStepLike): StepTelemetry | null {
	const out = step.outputJson;
	if (!out || typeof out !== "object") return null;
	const t = (out as { telemetry?: unknown }).telemetry;
	if (!t || typeof t !== "object") return null;
	return t as StepTelemetry;
}

/** Percentil por posição mais próxima (nearest-rank). Vazio devolve null. */
export function percentile(values: readonly number[], p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export type CategoryStats = {
	count: number;
	totalMs: number;
	p50: number | null;
	p95: number | null;
};

export type RunTelemetrySummary = {
	steps: number;
	model: CategoryStats;
	ttft: CategoryStats;
	tool: CategoryStats;
	overhead: CategoryStats;
	toolsByName: Record<string, CategoryStats>;
	llmRetries: number;
	retryReasons: Record<string, number>;
	/** Passos em que o modelo servido difere do pedido. */
	modelSwitches: number;
	tokens: {
		prompt: number;
		completion: number;
		cached: number;
		cacheWrite: number;
	};
	/** F2: cached/prompt do run (null sem prompt medido); meta de runs longas >= 0,8. */
	cacheRatio: number | null;
	/** Soma só dos custos informados; `costUnknownSteps` conta os sem custo. */
	costUsd: number | null;
	costUnknownSteps: number;
	/** true quando há passos sem custo: `costUsd` é parcial, nunca o total. */
	costPartial: boolean;
};

function stats(values: number[]): CategoryStats {
	return {
		count: values.length,
		totalMs: values.reduce((a, b) => a + b, 0),
		p50: percentile(values, 50),
		p95: percentile(values, 95),
	};
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

/**
 * Totais e P50/P95 por categoria (modelo, TTFT, tool, overhead) a partir dos
 * passos persistidos. Passos sem telemetria (runs antigos) são ignorados,
 * exceto `durationMs` de tool_result, usado como fallback de tool.
 */
export function summarizeRunTelemetry(
	steps: readonly TelemetryStepLike[],
): RunTelemetrySummary {
	const model: number[] = [];
	const ttft: number[] = [];
	const tool: number[] = [];
	const overhead: number[] = [];
	const byName = new Map<string, number[]>();
	const reasons: Record<string, number> = {};
	let llmRetries = 0;
	let modelSwitches = 0;
	let costSum = 0;
	let costKnown = 0;
	let costUnknownSteps = 0;
	const tokens = { prompt: 0, completion: 0, cached: 0, cacheWrite: 0 };

	for (const step of steps) {
		const t = stepTelemetryOf(step);
		const modelMs = num(t?.modelMs);
		if (modelMs !== undefined) {
			model.push(modelMs);
			const ttftMs = num(t?.ttftMs);
			if (ttftMs !== undefined) ttft.push(ttftMs);
			const attempts = num(t?.llmAttempts);
			if (attempts !== undefined && attempts > 1) llmRetries += attempts - 1;
			for (const reason of t?.retryReasons ?? []) {
				reasons[reason] = (reasons[reason] ?? 0) + 1;
			}
			if (t?.requestedModel && t?.servedModel && t.requestedModel !== t.servedModel) {
				modelSwitches += 1;
			}
			tokens.prompt += num(t?.promptTokens) ?? 0;
			tokens.completion += num(t?.completionTokens) ?? 0;
			tokens.cached += num(t?.cachedTokens) ?? 0;
			tokens.cacheWrite += num(t?.cacheWriteTokens) ?? 0;
			const cost = num(t?.costUsd);
			if (t?.costKind === "plan" || t?.provider === "chatgpt") { /* Plano não tem preço por chamada. */ }
			else if (cost === undefined) costUnknownSteps += 1;
			else {
				costSum += cost;
				costKnown += 1;
			}
		}
		const toolMs =
			num(t?.toolMs) ?? (step.type === "tool_result" ? num(step.durationMs) : undefined);
		if (toolMs !== undefined) {
			tool.push(toolMs);
			const name = t?.toolName ?? "unknown";
			byName.set(name, [...(byName.get(name) ?? []), toolMs]);
		}
		const overheadMs = num(t?.overheadMs);
		if (overheadMs !== undefined) overhead.push(overheadMs);
	}

	return {
		steps: steps.length,
		model: stats(model),
		ttft: stats(ttft),
		tool: stats(tool),
		overhead: stats(overhead),
		toolsByName: Object.fromEntries([...byName].map(([k, v]) => [k, stats(v)])),
		llmRetries,
		retryReasons: reasons,
		modelSwitches,
		tokens,
		cacheRatio: cacheHitRatio(tokens),
		costUsd: costKnown > 0 ? costSum : null,
		costUnknownSteps,
		costPartial: costUnknownSteps > 0,
	};
}

/** Texto pt-BR do custo: parcial quando há chamadas sem custo informado. */
export function formatCostLabel(costUsd: number | null | undefined, unknownCalls: number | undefined): string {
	const unknown = unknownCalls && unknownCalls > 0 ? unknownCalls : 0;
	const known = typeof costUsd === "number" ? `US$ ${costUsd.toFixed(4)}` : null;
	if (unknown === 0) return known ?? "custo não informado";
	const calls = `${unknown} ${unknown === 1 ? "chamada" : "chamadas"} sem custo`;
	return known ? `${known} (custo parcial: ${calls})` : `custo desconhecido: ${calls}`;
}

/**
 * Aplica um custo reconciliado ao `usageJson` do run: soma ao `costUsd` e
 * decrementa `costUnknownCalls` (nunca abaixo de 0; some quando zera, deixando
 * de ser parcial). Pura: devolve um objeto novo.
 */
export function applyReconciledCost<T extends { costUsd?: number; costUnknownCalls?: number }>(
	usage: T,
	costUsd: number,
): T {
	const { costUnknownCalls: unknown, ...rest } = usage;
	const remaining = Math.max(0, (unknown ?? 0) - 1);
	return {
		...rest,
		costUsd: (usage.costUsd ?? 0) + costUsd,
		...(remaining > 0 ? { costUnknownCalls: remaining } : {}),
	} as T;
}

/**
 * Modelo servido a destacar na UI: só quando difere do pedido (fallback do
 * provider). Ids são opacos; vazio/igual devolve null (nada a mostrar).
 */
export function servedModelNote(
	requested: string | null | undefined,
	served: string | null | undefined,
): string | null {
	const servedId = served?.trim();
	if (!servedId) return null;
	const requestedId = requested?.trim();
	if (!requestedId || requestedId === servedId) return null;
	return servedId;
}
