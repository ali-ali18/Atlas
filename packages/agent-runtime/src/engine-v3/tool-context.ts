import type { LlmToolCall } from "@workspace/llm";
import { persistConversationCardFromEvent, upsertTaskListCard } from "@workspace/db";
import { loadSandboxConfig, runSandboxOperation, type SandboxExecutionContext } from "@workspace/sandbox";
import type { ComputerUseEvent } from "@workspace/shared";
import { addUsage } from "../budget.js";
import { lastUserPlainText, recentAssistantPlainTexts, recentUserPlainTexts } from "../conversation-text.js";
import { withAgentPointer } from "../tools/agent-pointer.js";
import type { ToolContext } from "../tools/registry/types.js";
import { claimVision, createVisionClaimState } from "../tools/vision-fallback.js";
import { rankTools, toolSearchText } from "./bridge.js";
import type { V3Run } from "./state.js";

/**
 * O `ToolContext` que as tools do registro recebem (o mesmo executor do v1/v2: cofre, cartões, cards). Só o que o
 * v3 atende nesta fase; caderno, ajudantes e trabalho longo do v2 ficam de fora (ver relato do PR4).
 */
export function createToolContextFactory(run: V3Run) {
	const params = run.params;
	const executionContext: SandboxExecutionContext = { signal: params.abortSignal, ...(params.browserTabId ? { tabId: params.browserTabId } : {}) };
	const manager = withAgentPointer(params.manager.withExecutionContext?.(executionContext) ?? params.manager, (event) => run.emit(event));
	const sandboxEnabled = (params.sandboxEnabled ?? true) && loadSandboxConfig().enabled;
	const visionClaim = createVisionClaimState();
	const botProposals = { count: 0 };
	const pageValueUse = { calls: 0 };
	const imageModel = params.imageModel ?? process.env.ATLAS_IMAGE_MODEL?.trim();
	let generated = 0;
	const persistAndEmit = async (event: ComputerUseEvent) => {
		await persistConversationCardFromEvent(run.conversationId, event as Parameters<typeof persistConversationCardFromEvent>[1]).catch(() => undefined);
		await run.emit(event);
	};
	const getSessionId = (signal: AbortSignal | undefined) =>
		runSandboxOperation({ ...executionContext, signal }, 180_000, (inner) => params.getSessionId({ ...executionContext, signal: inner }));

	return (call: LlmToolCall, signal: AbortSignal | undefined, forceConfirm: boolean): ToolContext => ({
		loginAsked: run.loginAsked,
		secrets: run.secrets,
		health: run.health,
		hasTool: run.hasTool,
		timeZone: params.timeZone,
		manager: manager.withExecutionContext?.({ ...executionContext, signal }) ?? manager,
		...(params.attachments?.present ? { attachments: { runtime: params.attachments, vmAvailable: sandboxEnabled } } : {}),
		showImages: { remaining: () => Math.max(0, 6 - run.shown.images), add: (count) => { run.shown.images += count; }, emit: persistAndEmit },
		...(imageModel
			? {
					imageGeneration: {
						apiKey: params.apiKey,
						model: imageModel,
						remaining: () => Math.max(0, 3 - generated),
						add: (count: number) => { generated += count; },
						onCost: (costUsd: number | undefined) => { run.usage = addUsage(run.usage, costUsd !== undefined ? { costUsd } : { costUnknownCalls: 1 }); },
					},
				}
			: {}),
		mcp: params.mcp ?? null,
		apiConnector: params.apiConnector ?? null,
		email: params.email ?? undefined,
		toolResultMaxChars: params.toolResultMaxChars,
		toolSearch: (query, limit) => toolSearchText(query, rankTools(query, [...run.catalog.entries.values()], run.toolUsage, limit)),
		abortSignal: signal,
		getSessionId: () => getSessionId(signal),
		peekSessionId: params.peekSessionId,
		toolCallId: call.id,
		botId: run.botId,
		userId: run.userId,
		conversationId: run.conversationId,
		runId: run.runId,
		origin: run.origin,
		botProposals,
		...(run.origin === "routine" && params.routinePageId ? { routinePageId: params.routinePageId } : {}),
		autonomy: run.autonomy,
		skillStore: params.skillStore,
		jevMcpMode: params.jevMcpMode,
		evaluateMcpWithJev: params.evaluateMcpWithJev,
		userRequestText: [...params.messages].reverse().find((message) => message.role === "user")?.content ?? "",
		humanTurn: run.humanTurn,
		jev: params.jev,
		lessonFeedback: params.lessons?.recordFeedback,
		forceConfirm,
		mcpRun: run.mcpRun,
		objective: params.objective,
		lastUserText: lastUserPlainText(run.conversation),
		recentUserTexts: recentUserPlainTexts(run.conversation),
		recentAssistantTexts: recentAssistantPlainTexts(run.conversation),
		onRoutineMutated: params.onRoutineMutated,
		replyLanguage: run.language,
		...(params.alertRuleReader ? { alertRuleReader: params.alertRuleReader } : {}),
		...(params.pageValueFinder ? { pageValueFinder: params.pageValueFinder, pageValueUse } : {}),
		...(run.origin === "routine" && params.alertRun ? { alertRun: params.alertRun } : {}),
		...(params.userPush && (run.origin === "routine" || run.origin === "chat")
			? { userPush: { mode: params.userPush.mode, send: params.userPush.send, quiet: params.userPush.quiet, sent: { used: 0 }, log: (line: string) => console.log(`[push] ${line}`) } }
			: {}),
		...(params.proactive
			? {
					proactive: {
						userId: run.userId,
						botId: run.botId,
						runId: run.runId,
						origin: run.origin,
						conversationId: run.conversationId,
						settings: params.proactive.settings,
						reflection: run.origin === "proactive" && !run.conversationId,
						actions: { used: 0 },
						jev: params.jev,
						onRoutineMutated: params.onRoutineMutated,
						abortSignal: signal,
					},
				}
			: {}),
		getOperationalSnapshot: () => ({ step: run.step, model: run.lastModel, messages: run.conversation.length, consumedInputs: [...run.consumedInputIds] }),
		taskListStore: { get: () => run.taskListItems, set: (next) => { run.taskListItems = next; } },
		emitTaskList: async (items) => {
			// Só a lista que o MODELO manda neste run alimenta o empurrão E4 (sinal estrutural declarado por ele).
			run.ownTaskList = items.length > 0 ? items : undefined;
			await upsertTaskListCard(run.conversationId, run.runId, items).catch(() => undefined);
			await run.emit({ type: "task_list", items, ...(params.runId ? { runId: params.runId } : {}) });
		},
		createFileDeps: params.createFileDeps,
		runCodeDeps: params.runCodeDeps,
		emitFile: persistAndEmit,
		emitChart: persistAndEmit,
		pagesStore: params.pagesStore,
		pageShareStore: params.pageShareStore,
		emitPage: persistAndEmit,
		canSeeImages: params.canSeeUserImages !== false,
		claimVisionFallback: (reason) => claimVision(visionClaim, run.step, reason),
		currentStep: () => run.step,
		listScreenshotArtifacts: () => {
			const ids: string[] = [];
			for (const message of run.conversation) {
				if (!Array.isArray(message.content)) continue;
				for (const part of message.content) if (part.type === "screenshot_ref" && !ids.includes(part.artifactId)) ids.push(part.artifactId);
			}
			return ids;
		},
	});
}

export type ToolContextFactory = ReturnType<typeof createToolContextFactory>;
