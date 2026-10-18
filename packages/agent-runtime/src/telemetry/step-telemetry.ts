import type { CompleteChatWithToolsResult } from "@workspace/llm";
import { parseModelRef, type NavigateTiming, type StepTelemetry } from "@workspace/shared";

/**
 * F0 — telemetria por passo. Só metadados (tempos, contadores, ids de modelo,
 * números de uso). Nunca recebe nem devolve conteúdo de mensagem, args ou
 * resultado de tool: a assinatura abaixo aceita apenas o necessário.
 */

type ModelResultMeta = Pick<
	CompleteChatWithToolsResult,
	"model" | "usage" | "timing" | "generationId" | "fallbackFrom"
>;

const round = (ms: number) => Math.max(0, Math.round(ms));

/** Passo do modelo: tempos, modelo pedido x servido, retries, tokens e custo. */
export function modelStepTelemetry(input: {
	requestedModel: string;
	result: ModelResultMeta;
	/** Medido pelo runtime; usado se o `streamChat` não devolver `timing`. */
	fallbackModelMs: number;
	/** Medido pelo runtime no 1o delta; usado se `timing` não trouxer TTFT. */
	fallbackTtftMs?: number;
}): StepTelemetry {
	const { result, requestedModel } = input;
	const timing = result.timing;
	const usage = result.usage;
	const ttftMs = timing?.ttftMs ?? input.fallbackTtftMs;
	return {
		v: 1,
		provider: parseModelRef(result.model).provider,
		...(usage?.costKind ? { costKind: usage.costKind } : {}),
		...(usage?.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
		...(result.fallbackFrom ? { fallbackFrom: result.fallbackFrom } : {}),
		modelMs: round(timing?.totalMs ?? input.fallbackModelMs),
		...(ttftMs !== undefined ? { ttftMs: round(ttftMs) } : {}),
		requestedModel: timing?.requestedModel ?? requestedModel,
		servedModel: timing?.servedModel ?? result.model,
		llmAttempts: timing?.attempts ?? 1,
		...(timing && timing.retryReasons.length > 0
			? { retryReasons: [...timing.retryReasons] }
			: {}),
		...(usage?.promptTokens !== undefined ? { promptTokens: usage.promptTokens } : {}),
		...(usage?.completionTokens !== undefined
			? { completionTokens: usage.completionTokens }
			: {}),
		...(usage?.cachedTokens !== undefined ? { cachedTokens: usage.cachedTokens } : {}),
		...(usage?.cacheWriteTokens !== undefined
			? { cacheWriteTokens: usage.cacheWriteTokens }
			: {}),
		...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
		...(result.generationId ? { generationId: result.generationId } : {}),
	};
}

/** Tool: só o nome (identificador do schema) e o tempo do executor. */
export function toolStepTelemetry(
	toolName: string,
	toolMs: number,
	extra?: Pick<StepTelemetry, "nav" | "rung">,
): StepTelemetry {
	return {
		v: 1,
		toolName,
		toolMs: round(toolMs),
		...(extra?.nav ? { nav: extra.nav } : {}),
		...(extra?.rung ? { rung: extra.rung } : {}),
	};
}

/**
 * Quebra de tempo do navigate vinda do control server (`gotoMs`, `readyMs`, `textLength`).
 * Copia só esses números (nunca texto, URL ou campo desconhecido); vazio = undefined.
 */
export function navigateTimingTelemetry(result: unknown): NavigateTiming | undefined {
	if (!result || typeof result !== "object") return undefined;
	const source = result as Record<string, unknown>;
	const out: NavigateTiming = {};
	const pick = (from: string, to: keyof NavigateTiming) => {
		const value = source[from];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[to] = round(value);
	};
	pick("gotoMs", "gotoMs");
	pick("readyMs", "readyMs");
	pick("textLength", "textLen");
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Fechamento da decisão: overhead = total do passo - modelo - tools (>= 0).
 * Não repete `modelMs` (o passo do modelo já o carrega; evita contar em dobro).
 */
export function decisionStepTelemetry(input: {
	stepMs: number;
	modelMs: number;
	toolMsTotal: number;
}): StepTelemetry {
	return {
		v: 1,
		stepMs: round(input.stepMs),
		toolMsTotal: round(input.toolMsTotal),
		overheadMs: round(input.stepMs - input.modelMs - input.toolMsTotal),
	};
}
