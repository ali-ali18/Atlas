import { createHash } from "node:crypto";
import { readOpenRouterFallbackModels, streamChatWithTools, type CompleteChatWithToolsResult, type LlmMessage, type LlmToolCall } from "@workspace/llm";
import type { FinishReason } from "@workspace/shared";
import { addUsage } from "../budget.js";
import { resolveLlmMessagesForModel, createMediaMemo } from "../checkpoint.js";
import { contextBudgetFor } from "../context/budget.js";
import { namespaceToolCallId, renameProviderItemCallIds } from "../context/transcript.js";
import { COLLAPSE_BATCH_MAX_CHARS, COLLAPSE_BATCH_SIZE, KEEP_RECENT_SCREENSHOTS, RECENT_TOOL_GROUPS_KEPT, applyPromptHygiene, omitOldScreenshots } from "../hygiene.js";
import { createReasoningEffortPicker } from "../reasoning-effort.js";
import { sanitizeAssistantText } from "../sanitize-assistant-text.js";
import { modelUsage } from "../telemetry/model-usage.js";
import { modelStepTelemetry } from "../telemetry/step-telemetry.js";
import { toolsJsonCharsOf } from "../tools-json-size.js";
import { callCostUsd, fallbackPricesFromEnv } from "../engine-v2/cost.js";
import { withTransportRetry, type TransportOptions } from "./failures.js";
import type { V3Run } from "./state.js";

export type ModelReply = {
	text: string;
	/** Texto cru do modelo (o que saiu ao vivo): a continuação de uma resposta cortada junta o cru e só então limpa. */
	raw: string;
	toolCalls: LlmToolCall[];
	providerItems?: LlmMessage["providerItems"];
	finishReason?: FinishReason;
	result: CompleteChatWithToolsResult;
};

/**
 * MODEL_STEP (desenho 2.1): uma chamada de modelo em streaming. O histórico canônico não muda aqui; só a cópia
 * enviada passa pela higiene (capturas antigas, resultados grandes). Transporte com 3 tentativas e a cadeia de
 * fallback configurada. Grava o span do modelo (`onStep` tipo `model`, mesmo caminho do PR3c).
 */
export function createModelStep(run: V3Run, deps: { sleep?: TransportOptions["sleep"]; transportDelaysMs?: readonly number[] } = {}) {
	const params = run.params;
	const streamChat = params.streamChat ?? streamChatWithTools;
	const pickReasoning = createReasoningEffortPicker({ effort: params.reasoningEffort, supportsReasoning: params.modelSupportsReasoning });
	const memo = createMediaMemo();
	const prices = fallbackPricesFromEnv();
	const sessionId = run.conversationId ? `c${createHash("sha256").update(`${run.botId ?? ""}:${run.conversationId}`).digest("hex").slice(0, 31)}` : run.runId;

	return async (input: { messageId: string; toolChoice: "auto" | "none" }): Promise<ModelReply> => {
		const toolsChars = toolsJsonCharsOf(run.tools);
		const hygiene = applyPromptHygiene(omitOldScreenshots(run.conversation, KEEP_RECENT_SCREENSHOTS), {
			language: run.language,
			contextLength: params.contextLength,
			toolsJsonChars: toolsChars,
			model: run.model,
			contextBudget: params.contextBudget ?? contextBudgetFor(params.contextMemory, params.contextLength),
			objectiveText: params.objective ?? "",
			keepRecentGroups: RECENT_TOOL_GROUPS_KEPT,
			collapseBatch: { size: COLLAPSE_BATCH_SIZE, maxPendingChars: COLLAPSE_BATCH_MAX_CHARS },
		});
		const transport = await resolveLlmMessagesForModel(hygiene.messages, params.loadScreenshot, {
			canSeeUserImages: params.canSeeUserImages,
			canSeeScreenshots: params.canSeeUserImages !== false,
			loadUserImage: params.loadUserImage ? (artifactId) => params.loadUserImage!(artifactId, { retryTransient: true }) : undefined,
			canReadNativePdf: params.attachments?.canReadNativePdf === true,
			loadUserPdf: params.attachments?.loadPdfDataUrl,
			memo,
		});
		const reasoning = await pickReasoning(run.model);
		// A cadeia de fallback é do v3 (abaixo), não do transporte: `fallbackModels: []` evita trocar de modelo duas vezes.
		// Com imagem no pedido, nenhum fallback (o catálogo de fallback não garante visão), como no transporte.
		const hasImage = transport.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url" || part.type === "file"));
		const fallbackModels = hasImage ? [] : (params.fallbackModels ?? readOpenRouterFallbackModels());
		let delivered = false;
		let firstDeltaMs: number | undefined;
		let deltaTail = Promise.resolve();
		const startedAt = performance.now();
		const result = await withTransportRetry(
			(model) =>
				streamChat(
					{
						messages: transport,
						model,
						apiKey: params.apiKey,
						// Tools ficam no pedido mesmo no FINAL_STEP (`toolChoice: "none"`): o prefixo em cache não muda.
						tools: run.tools,
						toolChoice: run.tools.length === 0 ? "none" : input.toolChoice,
						signal: params.abortSignal,
						timeoutMs: params.modelCallTimeoutMs,
						firstEventTimeoutMs: params.firstEventTimeoutMs,
						idleTimeoutMs: params.idleTimeoutMs,
						fallbackModels: [],
						maxOutputTokens: params.maxOutputTokens,
						reasoningMaxTokens: params.reasoningMaxTokens,
						...(reasoning ? { reasoningEffort: reasoning } : {}),
						sessionId,
					},
					{
						onDelta: (delta) => {
							delivered = true;
							firstDeltaMs ??= performance.now() - startedAt;
							deltaTail = deltaTail.then(() => run.emit({ type: "assistant_delta", id: input.messageId, delta })).catch(() => undefined);
						},
					},
				),
			{
				model: run.model,
				fallbackModels,
				delivered: () => delivered,
				...(params.abortSignal ? { signal: params.abortSignal } : {}),
				...(deps.sleep ? { sleep: deps.sleep } : {}),
				...(deps.transportDelaysMs ? { delaysMs: deps.transportDelaysMs } : {}),
			},
		);
		await deltaTail;
		run.lastModel = result.model;
		const usage = modelUsage(result);
		run.usage = addUsage(run.usage, usage);
		const cost = callCostUsd(usage, prices);
		if (cost.estimated) run.estimatedCostUsd += cost.costUsd;
		const text = sanitizeAssistantText(result.message.content ?? "");
		const toolCalls = (result.message.tool_calls ?? []).map((call) => ({ ...call, id: namespaceToolCallId(call.id, run.runId) }));
		const telemetry = modelStepTelemetry({ requestedModel: run.model, result, fallbackModelMs: performance.now() - startedAt, fallbackTtftMs: firstDeltaMs });
		await params.onStep?.({
			decisionIndex: run.step,
			subIndex: 0,
			type: "model",
			status: "completed",
			idempotencyKey: `${run.runId}:model:${run.step}`,
			tokens: usage.totalTokens,
			durationMs: telemetry.modelMs,
			telemetry,
			...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
			outputJson: { content: text, toolCallIds: toolCalls.map((call) => call.id), engine: "v3", ...(result.finishReason ? { finishReason: result.finishReason } : {}) },
		});
		const providerItems = renameProviderItemCallIds(result.message.providerItems, (id) => namespaceToolCallId(id, run.runId));
		return { text, raw: result.message.content ?? "", toolCalls, ...(providerItems ? { providerItems } : {}), ...(result.finishReason ? { finishReason: result.finishReason } : {}), result };
	};
}

export type ModelStep = ReturnType<typeof createModelStep>;
