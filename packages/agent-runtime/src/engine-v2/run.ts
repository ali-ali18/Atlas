/**
 * Motor v2 (ADR 0002, F2): um laço simples ao lado do `runComputerUse`, ligado por bot (`policyJson.engine = "v2"`).
 *
 * monta mensagens -> chama o modelo com as tools do registro -> executa as tool calls -> repete até o modelo
 * responder sem tools. Quem decide parar é o Supervisor (orçamento em US$ e tempo, ver `supervisor.ts`); a lista de
 * tarefas é obrigatória em trabalho longo (`task-list.ts`). O contrato de entrada/saída é o do v1
 * (`ComputerUseParams` -> `RunComputerUseResult`), então o worker troca de motor sem mudar o resto.
 *
 * As tools são as mesmas do v1: executam por `executeTool` (cofre, confirmações, cards) com um `ToolContext`
 * montado aqui. O que o v1 faz e o v2 ainda não: ver a seção "Limites desta fase" em docs/features/motor-v2.md.
 */
import { createHash } from "node:crypto";
import {
	type ChatTool,
	type CompleteChatWithToolsResult,
	type LlmContentPart,
	type LlmMessage,
	type LlmToolCall,
	streamChatWithTools,
} from "@workspace/llm";
import {
	type BotLanguage,
	type ComputerUseEvent,
	type RunStop,
	type TaskListItem,
	DEFAULT_AUTONOMY_LEVEL,
	type EffectiveAutonomy,
	allLanguageInstructions,
	buildPersonaBlock,
	buildToolResultStatus,
	classifyFinish,
	decideAction,
	isMcpToolName,
	isUntrustedContentTool,
	languageInstruction,
	parseQuestionnaireAnsweredContent,
	parseTaskList,
	renderTaskListNote,
	resolveReplyLanguage,
	TRANSCRIPT_SLOT,
} from "@workspace/shared";
import {
	getBotProfile,
	getConversationUntrustedAt,
	markConversationUntrusted,
	markMcpTaskGrantsUntrusted,
	persistConversationCardFromEvent,
	upsertTaskListCard,
} from "@workspace/db";
import { loadSandboxConfig, runSandboxOperation, type SandboxExecutionContext } from "@workspace/sandbox";
import { addUsage, emptyUsage, wallClockAnchors, type TokenUsage } from "../budget.js";
import {
	buildRuntimeCheckpoint,
	completedToolCallIds,
	createMediaMemo,
	hydrateLlmMessages,
	parseRuntimeCheckpoint,
	resolveLlmMessagesForModel,
	toolIdempotencyKey,
} from "../checkpoint.js";
import {
	OFFERED_TOOLS_SUB_INDEX,
	budgetStopFallbackText,
	connectorsPrompt,
	lastUserPlainText,
	parseArgs,
	recentAssistantPlainTexts,
	recentUserPlainTexts,
	sanitizeAssistantText,
	unavailableToolMessage,
	type ComputerUseParams,
	type RunComputerUseResult,
} from "../computer-use.js";
import { todayNote } from "../context/today-note.js";
import { contextBudgetFor } from "../context/budget.js";
import { namespaceToolCallId, renameProviderItemCallIds } from "../context/transcript.js";
import { STUB_LAST_GROUP_MAX_CHARS, applyPromptHygiene } from "../hygiene.js";
import { toolsJsonCharsOf } from "../tools-json-size.js";
import { modelStepTelemetry } from "../telemetry/step-telemetry.js";
import { isUnattendedOrigin } from "../autonomy-gate.js";
import {
	AgentRunCancelledError,
	AgentRunPausedError,
	errorFromAbortSignal,
	isControlFlowError,
} from "../errors.js";
import { INTERRUPTED_WRITE_NOTE, ToolEffectUncertainError, hashEffectArgs, isJournaledWrite } from "../execution/journal.js";
import { EMPTY_REPLY_FALLBACK_TEXT, EMPTY_REPLY_NOTE, TRUNCATED_REPLY_NOTE, createTaskTracker } from "../execution/task-state.js";
import { appendToLatestToolResult } from "../loop/tool-result-notes.js";
import { swapLanguageInstruction } from "../loop/prompt-builder.js";
import { isBotConfigEventObjective } from "../tools/registry/helpers.js";
import { toolArgsKey, toolResultKey } from "../progress.js";
import { MAX_PARALLEL_READS } from "../read-execution.js";
import { modelUsage } from "../telemetry/model-usage.js";
import { createSecretSession, type SecretSession } from "../secrets/session.js";
import { createProviderHealth } from "../tools/provider-health.js";
import { withAgentPointer } from "../tools/agent-pointer.js";
import { executeTool } from "../tools/registry/execute.js";
import { getToolRegistration } from "../tools/registry/index.js";
import { isSandboxTool } from "../tools/registry/sandbox-tools.js";
import type { ToolContext } from "../tools/registry/types.js";
import { executeUpdateTaskList, type TaskListStore } from "../tools/task-list.js";
import { classifyToolFailure, withArgumentErrorHint } from "../tool-failure.js";
import { buildEngineV2Catalog } from "./catalog.js";
import { buildEngineV2SystemPrompt } from "./prompt.js";
import { type SupervisorProfile, budgetForProfile, createSupervisor, deliveryInstruction } from "./supervisor.js";
import { appendUnconfirmed, createTaskListGate, droppedItems, openItems } from "./task-list.js";

export type EngineV2Options = {
	profile: SupervisorProfile;
	/** Ajuste do bot para o trabalho longo (`policyJson.longWorkBudgetUsd` / `longWorkMinutes`). */
	longWorkBudgetUsd?: number;
	longWorkMinutes?: number;
};

const CLOSING_CALL_TIMEOUT_MS = 60_000;
/** Mensagem de runtime que não foi escrita pelo usuário (o modelo não a responde como se fosse dele). */
const AUTO_CONTEXT = "[auto-context, not written by the user]";

type AwaitingKind = "confirm" | "skill_card" | "questionnaire" | "profile";

type CallOutcome = {
	call: LlmToolCall;
	name: string;
	ok: boolean;
	summary: string;
	args: Record<string, unknown>;
	/** Bloqueada pelo Supervisor: não conta para travamento. */
	blocked?: boolean;
	/** A chamada não rodou porque o run vai esperar o usuário. */
	skipped?: boolean;
};

export async function runEngineV2(params: ComputerUseParams, options: EngineV2Options): Promise<RunComputerUseResult> {
	const onEvent = params.onEvent;
	const runId = params.runId ?? "local";
	const userId = params.userId ?? "default";
	const botId = params.botId;
	const conversationId = params.conversationId;
	const origin = params.origin ?? "chat";
	const apiKey = params.apiKey;
	const streamChat = params.streamChat ?? streamChatWithTools;
	const parsed = parseRuntimeCheckpoint(params.restoredCheckpoint);
	let model = params.model;
	let lastModel = params.model;
	const contextLength = params.contextLength;
	const sandboxEnabled = (params.sandboxEnabled ?? true) && loadSandboxConfig().enabled;

	// --- orçamento e relógio (só tempo ATIVO: pausa e fila não contam) ---
	const budget = budgetForProfile(options.profile, {
		longWorkBudgetUsd: options.longWorkBudgetUsd,
		longWorkMinutes: options.longWorkMinutes,
		accountCapUsd: params.budget?.maxCostUsd,
	});
	const supervisor = createSupervisor({ profile: options.profile, budget });
	const wall = wallClockAnchors({ maxWallMs: budget.maxActiveMs, now: Date.now(), runStartedAt: params.runStartedAt, restored: parsed });
	const activeElapsedMs = () => wall.baseMs + (Date.now() - wall.executionStartMs);
	// Folga de 25% sobre o orçamento de tempo só para as operações do computador não ficarem presas para sempre.
	const deadlineAtMs = wall.executionStartMs + Math.round(Math.max(0, budget.maxActiveMs - wall.baseMs) * 1.25);
	const executionContext = { signal: params.abortSignal, deadlineAtMs, ...(params.browserTabId ? { tabId: params.browserTabId } : {}) };
	const manager = withAgentPointer(params.manager.withExecutionContext?.(executionContext) ?? params.manager, (event) => onEvent(event));
	const getSessionId = (context: SandboxExecutionContext = executionContext) =>
		runSandboxOperation(context, 180_000, (signal) => params.getSessionId({ ...context, signal }));

	let usageTotals: TokenUsage = parsed?.usageTotals ? { ...emptyUsage(), ...parsed.usageTotals } : emptyUsage();
	const toolCallCounts = new Map<string, number>(Object.entries(parsed?.toolCallCounts ?? {}));
	let step = parsed?.nextStepIndex ?? 0;
	const consumedInputIds = new Set<string>(parsed?.consumedInputIds ?? []);
	const loginAsked = new Set(parsed?.loginAsked ?? []);
	let pendingLogin = parsed?.pendingLogin;

	const ensureContinue = async (signal: AbortSignal | undefined = params.abortSignal) => {
		if (signal?.aborted) throw errorFromAbortSignal(signal);
		if (params.shouldContinue && !(await params.shouldContinue())) throw new AgentRunCancelledError();
	};
	const ensureNotPaused = async () => {
		if (params.shouldPause && (await params.shouldPause())) throw new AgentRunPausedError();
	};

	// --- contexto do usuário ---
	const lastUserMessage = [...params.messages].reverse().find((message) => message.role === "user")?.content ?? "";
	const humanTurn =
		params.humanTurn === true &&
		!isBotConfigEventObjective(params.objective ?? "") &&
		!isBotConfigEventObjective(lastUserMessage) &&
		!parseQuestionnaireAnsweredContent(lastUserMessage);
	const botProfile = botId ? await (params.loadBotProfile ?? getBotProfile)(botId, params.userId).catch(() => null) : null;
	const allowProfileUpdate =
		!botProfile?.description?.trim() ||
		isBotConfigEventObjective(params.objective ?? "") ||
		isBotConfigEventObjective(lastUserMessage) ||
		parseQuestionnaireAnsweredContent(lastUserMessage)?.purpose === "onboarding";
	const replyLanguage = resolveReplyLanguage({ setting: params.language ?? "pt-BR", ...params.languageContext, hasUserMessage: origin === "chat" });
	const language: BotLanguage = replyLanguage.language;
	const languageAtEnd = params.language === "auto";
	const canSeeImages = params.canSeeUserImages !== false;

	let autonomyPolicy: EffectiveAutonomy = params.autonomy ?? { level: DEFAULT_AUTONOMY_LEVEL, exceptions: [] };
	const autonomyHandle = { get: () => autonomyPolicy, set: (next: EffectiveAutonomy) => { autonomyPolicy = next; } };

	// --- catálogo de tools ---
	const mcp = params.mcp ?? null;
	const imageIds = params.userImageArtifactIds ?? parsed?.userImageArtifactIds ?? [];
	const catalog = buildEngineV2Catalog({
		origin,
		userId,
		sandboxEnabled,
		autonomy: autonomyPolicy,
		toolFilter: params.toolFilter,
		mcp,
		apiConnector: Boolean(params.apiConnector),
		email: params.email,
		attachments: { present: params.attachments?.present === true },
		planMode: params.planMode,
		allowProfileUpdate,
		hasImageAttachments: imageIds.length > 0,
		routerMessages: params.messages,
		lastUserMessage,
		objective: params.objective,
		priorLoadedTools: params.priorLoadedTools ?? parsed?.loadedTools,
	});
	const tools = catalog.tools;
	const hasToolInRun = (name: string) => tools.some((tool) => tool.function.name === name) || Boolean(catalog.deferral?.isDeferred(name));

	// --- lista de tarefas (a mesma do v1: TaskTracker + cartão da doca) ---
	const taskTracker = createTaskTracker(parsed?.taskState, params.objective ?? lastUserMessage);
	if (!parsed?.taskState) taskTracker.setTaskList(parseTaskList(params.priorTaskList));
	const taskListStore: TaskListStore = { get: () => taskTracker.taskList(), set: (next) => taskTracker.setTaskList(next) };
	/** Última lista que o modelo enviou (a do tracker some quando tudo conclui; o portão e os descartados precisam dela). */
	let lastTaskItems: TaskListItem[] | undefined = taskTracker.taskList();
	const emitTaskListEvent = async (items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>) => {
		lastTaskItems = items.length > 0 ? items : undefined;
		await upsertTaskListCard(conversationId, runId, items).catch(() => undefined);
		await onEvent({ type: "task_list", items, ...(params.runId ? { runId: params.runId } : {}) });
	};
	const taskGate = createTaskListGate({ required: options.profile === "long_work" && hasToolInRun("update_task_list") });
	const currentTaskItems = (): TaskListItem[] | undefined => taskTracker.taskList() ?? lastTaskItems;

	// --- cofre, confiança e integrações ---
	const secretSession: SecretSession | undefined = params.userId
		? createSecretSession({ userId: params.userId, by: () => ({ actor: "bot", botId, conversationId }) })
		: undefined;
	const providerHealth = params.providerHealth ?? createProviderHealth();
	let conversationUntrustedRead: Promise<boolean> | undefined;
	const conversationUntrusted = () =>
		(conversationUntrustedRead ??= userId && conversationId
			? getConversationUntrustedAt({ userId, conversationId }).then((at) => at !== null, () => true)
			: Promise.resolve(false));
	const mcpRun = { untrustedSeen: parsed?.untrustedSeen === true, executed: [] as string[], conversationUntrusted };
	let grantsMarkedUntrusted = false;
	const markUntrusted = async () => {
		mcpRun.untrustedSeen = true;
		if (grantsMarkedUntrusted || !userId || !conversationId) return;
		grantsMarkedUntrusted = true;
		await Promise.all([
			markConversationUntrusted({ userId, conversationId }),
			markMcpTaskGrantsUntrusted({ userId, conversationId }),
		]).catch(() => { grantsMarkedUntrusted = false; });
	};
	let shownImageCount = parsed?.shownImageCount ?? 0;
	let generatedImageCount = parsed?.generatedImageCount ?? 0;
	const imageModel = params.imageModel ?? process.env.ATLAS_IMAGE_MODEL?.trim();
	const configuredImageLimit = Number(process.env.ATLAS_IMAGE_MAX_PER_RUN);
	const maxGeneratedImages = Number.isInteger(configuredImageLimit) && configuredImageLimit > 0 ? Math.min(configuredImageLimit, 10) : 3;

	// --- conversa inicial ---
	const turnId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
	const priorHistory = params.priorTranscript?.length ? await hydrateLlmMessages(params.priorTranscript) : [];
	const placeTranscript = <T extends { role: string; content: unknown }>(list: T[]): LlmMessage[] => {
		const slot = list.findIndex((message) => message.role === "system" && message.content === TRANSCRIPT_SLOT);
		if (slot < 0) return list as unknown as LlmMessage[];
		return [...(list.slice(0, slot) as unknown as LlmMessage[]), ...priorHistory, ...(list.slice(slot + 1) as unknown as LlmMessage[])];
	};
	let conversation: LlmMessage[];
	if (parsed?.llmMessages?.length) {
		conversation = await hydrateLlmMessages(parsed.llmMessages);
		const system = conversation.find((message) => message.role === "system");
		if (system) system.content = swapLanguageInstruction(typeof system.content === "string" ? system.content : "", allLanguageInstructions(), replyLanguage.instruction);
		else conversation.unshift({ role: "system", content: replyLanguage.instruction });
	} else {
		const systemPrompt = buildEngineV2SystemPrompt({
			persona: buildPersonaBlock({ name: botProfile?.name, role: botProfile?.description, language: params.language ?? "pt-BR" }),
			profile: options.profile,
			model,
			connectors: mcp && mcp.toolset.entries.size > 0 ? `\n\n${connectorsPrompt(mcp.toolset)}` : "",
			skillIndex: params.skillIndex,
			toolIndex: catalog.index,
			preloadedGroups: catalog.preloaded,
			atlasUrl: process.env.ATLAS_URL,
			languageInstruction: languageAtEnd ? replyLanguage.instruction : undefined,
		});
		conversation = [
			{ role: "system", content: systemPrompt },
			...placeTranscript(params.messages.map((message) => ({ role: message.role, content: message.content }))),
		];
		const lastUser = [...conversation].reverse().find((message) => message.role === "user");
		if (lastUser && imageIds.length > 0) {
			lastUser.content = [
				{ type: "text", text: typeof lastUser.content === "string" ? lastUser.content : "" },
				...imageIds.slice(0, 4).map((artifactId) => ({ type: "image_ref" as const, artifactId })),
			];
		}
		if (lastUser && params.attachments?.turnContext) {
			const existing: LlmContentPart[] = typeof lastUser.content === "string" ? [{ type: "text", text: lastUser.content }] : Array.isArray(lastUser.content) ? lastUser.content : [];
			lastUser.content = [
				...existing,
				{ type: "text", text: params.attachments.turnContext },
				...(params.attachments.nativePdfs ?? []).map((pdf) => ({ type: "file_ref" as const, artifactId: pdf.id, filename: pdf.filename })),
			];
		}
	}

	// --- checkpoint ---
	let checkpointTail: Promise<void> = Promise.resolve();
	const snapshotCheckpoint = (stepIndex: number) =>
		buildRuntimeCheckpoint({
			messages: params.messages,
			conversation,
			userImageArtifactIds: imageIds,
			generatedImageCount,
			shownImageCount,
			nextStepIndex: stepIndex,
			model: lastModel,
			consumedInputIds: [...consumedInputIds],
			usageTotals,
			toolCallCounts: Object.fromEntries(toolCallCounts),
			loginAsked: [...loginAsked],
			untrustedSeen: mcpRun.untrustedSeen,
			pendingLogin,
			taskState: taskTracker.persistable(),
			activeElapsedMs: activeElapsedMs(),
			loadedTools: [...catalog.activeMcpTools(), ...tools.map((tool) => tool.function.name).filter((name) => !isMcpToolName(name))],
			transcriptWatermark: parsed?.transcriptWatermark ?? params.transcriptWatermark,
			carriedNotes: parsed?.carriedNotes ?? params.carriedNotes,
			recoveries: parsed?.recoveries,
			recoveredAtStep: parsed?.recoveredAtStep,
		});
	const persistCheckpoint = (stepIndex: number) => {
		if (!params.onCheckpoint) return Promise.resolve();
		const snapshot = snapshotCheckpoint(stepIndex);
		const write = checkpointTail.then(() => params.onCheckpoint!(snapshot));
		checkpointTail = write.catch(() => undefined);
		return write;
	};

	// --- retomada depois do login ---
	if (pendingLogin) {
		const resumed = pendingLogin;
		pendingLogin = undefined;
		const captcha = resumed.reason === "captcha";
		conversation.push({
			role: "user",
			content: captcha
				? `[captcha-complete] The user says they solved the verification on ${resumed.site}. Your next action must be browser_snapshot to re-read the page, then continue the task from where you stopped. If the captcha is still there, do not ask again: use another source or report it.`
				: `[login-complete] The user says they finished logging in to ${resumed.site}. Your next action must be browser_snapshot to re-read the page, then continue the task from where you stopped. Never type credentials.`,
		});
		const doneEvent = { type: "login" as const, loginId: resumed.loginId, site: resumed.site, url: resumed.url, runId, status: "done" as const, ...(resumed.reason ? { reason: resumed.reason } : {}) };
		await persistConversationCardFromEvent(conversationId, doneEvent).catch(() => undefined);
		await onEvent(doneEvent);
		await persistCheckpoint(step);
	}

	// --- chamada ao modelo ---
	const closingSignal = () => AbortSignal.any([...(params.abortSignal ? [params.abortSignal] : []), AbortSignal.timeout(CLOSING_CALL_TIMEOUT_MS)]);
	const mediaMemo = createMediaMemo();
	const hygieneLastGroupChars = Math.max(STUB_LAST_GROUP_MAX_CHARS, (params.toolResultMaxChars ?? 0) + 4_000);
	const modelStep = async (
		history: LlmMessage[],
		toolChoice: "auto" | "none",
		messageId: string,
		closing = false,
	): Promise<{ content: string; toolCalls: LlmToolCall[]; providerItems?: LlmMessage["providerItems"]; usage: TokenUsage; result: CompleteChatWithToolsResult; telemetry: ReturnType<typeof modelStepTelemetry> }> => {
		await ensureContinue(closing ? params.abortSignal : undefined);
		await ensureNotPaused();
		const hygiene = applyPromptHygiene(history, {
			language,
			lastGroupMaxChars: hygieneLastGroupChars,
			contextLength,
			toolsJsonChars: toolsJsonCharsOf(tools),
			model,
			contextBudget: params.contextBudget ?? contextBudgetFor(params.contextMemory, contextLength),
			objectiveText: params.objective ?? lastUserMessage,
			taskState: () => taskTracker.snapshot(),
		});
		conversation = hygiene.messages;
		const taskNote = renderTaskListNote(taskTracker.taskList());
		const nowNote = process.env.ATLAS_NOW_NOTE === "off" ? null : todayNote(new Date(), params.timeZone);
		const layers = [taskNote, nowNote].filter((layer): layer is string => Boolean(layer));
		const withLayers: LlmMessage[] = layers.length ? [...conversation, ...layers.map((content) => ({ role: "system" as const, content }))] : conversation;
		const transport = await resolveLlmMessagesForModel(withLayers, params.loadScreenshot, {
			canSeeUserImages: params.canSeeUserImages,
			canSeeScreenshots: canSeeImages,
			loadUserImage: params.loadUserImage ? (artifactId) => params.loadUserImage!(artifactId, { retryTransient: true }) : undefined,
			canReadNativePdf: params.attachments?.canReadNativePdf === true,
			loadUserPdf: params.attachments?.loadPdfDataUrl,
			memo: mediaMemo,
		});
		let collected = "";
		let deltaTail = Promise.resolve();
		const callStartedAt = performance.now();
		let firstDeltaMs: number | undefined;
		const result = await streamChat(
			{
				messages: transport,
				model,
				apiKey,
				tools,
				toolChoice,
				signal: closing ? closingSignal() : params.abortSignal,
				timeoutMs: closing ? CLOSING_CALL_TIMEOUT_MS : params.modelCallTimeoutMs,
				firstEventTimeoutMs: params.firstEventTimeoutMs,
				idleTimeoutMs: params.idleTimeoutMs,
				fallbackModels: params.fallbackModels,
				maxOutputTokens: params.maxOutputTokens ?? (process.env.LLM_MAX_OUTPUT_TOKENS ? Number(process.env.LLM_MAX_OUTPUT_TOKENS) : undefined),
				reasoningMaxTokens: params.reasoningMaxTokens,
				sessionId: !conversationId ? params.runId : `c${createHash("sha256").update(`${botId ?? ""}:${conversationId}`).digest("hex").slice(0, 31)}`,
				...(layers.length > 0 ? { cacheStableIndex: conversation.length - 1 } : {}),
			},
			{
				onDelta: (delta) => {
					firstDeltaMs ??= performance.now() - callStartedAt;
					collected += delta;
					// Delta é só exibição ao vivo: falha ao gravar nunca descarta a resposta já recebida.
					deltaTail = deltaTail.then(() => Promise.resolve(onEvent({ type: "assistant_delta", id: messageId, delta }))).catch(() => undefined);
				},
			},
		);
		await deltaTail;
		lastModel = result.model;
		const usage = modelUsage(result);
		usageTotals = addUsage(usageTotals, usage);
		return {
			content: result.message.content ?? collected,
			toolCalls: (result.message.tool_calls ?? []).map((call) => ({ ...call, id: namespaceToolCallId(call.id, runId) })),
			providerItems: renameProviderItemCallIds(result.message.providerItems, (id) => namespaceToolCallId(id, runId)),
			usage,
			result,
			telemetry: modelStepTelemetry({ requestedModel: model, result, fallbackModelMs: performance.now() - callStartedAt, fallbackTtftMs: firstDeltaMs }),
		};
	};

	// --- execução de uma tool call ---
	const entryOf = (name: string) => mcp?.toolset.entries.get(name);
	const pendingMedia = new Map<string, LlmContentPart[]>();
	const awaiting: { kind?: AwaitingKind } = {};
	let loginToAsk: Extract<ComputerUseEvent, { type: "login" }> | undefined;

	const emitSynthetic = async (call: LlmToolCall, name: string, message: string, args: Record<string, unknown> = {}): Promise<CallOutcome> => {
		await onEvent({ type: "tool_call", id: call.id, name, args: call.function.arguments, step });
		await onEvent({ type: "tool_result", id: call.id, name, ok: false, summary: message });
		return { call, name, ok: false, summary: message, args };
	};

	const buildContext = (call: LlmToolCall, signal: AbortSignal | undefined, forceConfirm = false): ToolContext => ({
		loginAsked,
		secrets: secretSession,
		health: providerHealth,
		hasTool: hasToolInRun,
		timeZone: params.timeZone,
		manager: manager.withExecutionContext?.({ ...executionContext, signal }) ?? manager,
		...(params.attachments?.present ? { attachments: { runtime: params.attachments, vmAvailable: sandboxEnabled } } : {}),
		showImages: {
			remaining: () => Math.max(0, 6 - shownImageCount),
			add: (count) => { shownImageCount += count; },
			emit: async (event) => {
				await persistConversationCardFromEvent(conversationId, event);
				await onEvent(event);
			},
		},
		...(imageModel ? { imageGeneration: {
			apiKey, model: imageModel,
			remaining: () => Math.max(0, maxGeneratedImages - generatedImageCount),
			add: (count: number) => { generatedImageCount += count; },
			onCost: (costUsd: number | undefined) => { usageTotals = addUsage(usageTotals, costUsd !== undefined ? { costUsd } : { costUnknownCalls: 1 }); },
		} } : {}),
		mcp,
		apiConnector: params.apiConnector ?? null,
		email: params.email ?? undefined,
		toolResultMaxChars: params.toolResultMaxChars,
		activateMcpTools: mcp ? catalog.activateMcpTools : undefined,
		nativeDeferral: catalog.deferral ?? undefined,
		abortSignal: signal,
		getSessionId: () => getSessionId({ ...executionContext, signal }),
		peekSessionId: params.peekSessionId,
		toolCallId: call.id,
		botId,
		userId,
		conversationId,
		runId,
		origin,
		autonomy: autonomyHandle,
		skillStore: params.skillStore,
		jevMcpMode: params.jevMcpMode,
		evaluateMcpWithJev: params.evaluateMcpWithJev,
		userRequestText: lastUserMessage,
		humanTurn,
		jev: params.jev,
		lessonFeedback: params.lessons?.recordFeedback,
		forceConfirm,
		mcpRun,
		objective: params.objective,
		lastUserText: lastUserPlainText(conversation),
		recentUserTexts: recentUserPlainTexts(conversation),
		recentAssistantTexts: recentAssistantPlainTexts(conversation),
		onRoutineMutated: params.onRoutineMutated,
		replyLanguage: language,
		...(params.alertRuleReader ? { alertRuleReader: params.alertRuleReader } : {}),
		...(params.pageValueFinder ? { pageValueFinder: params.pageValueFinder } : {}),
		getOperationalSnapshot: () => ({ step, model: lastModel, messages: conversation.length, consumedInputs: [...consumedInputIds] }),
		taskListStore,
		emitTaskList: emitTaskListEvent,
		createFileDeps: params.createFileDeps,
		runCodeDeps: params.runCodeDeps,
		emitFile: async (event) => {
			await persistConversationCardFromEvent(conversationId, event).catch(() => undefined);
			await onEvent(event);
		},
		emitChart: async (event) => {
			await persistConversationCardFromEvent(conversationId, event).catch(() => undefined);
			await onEvent(event);
		},
		pagesStore: params.pagesStore,
		pageShareStore: params.pageShareStore,
		emitPage: async (event) => {
			await persistConversationCardFromEvent(conversationId, event).catch(() => undefined);
			await onEvent(event);
		},
		canSeeImages,
		currentStep: () => step,
		listScreenshotArtifacts: () => {
			const ids: string[] = [];
			for (const message of conversation) {
				if (!Array.isArray(message.content)) continue;
				for (const part of message.content) if (part.type === "screenshot_ref" && !ids.includes(part.artifactId)) ids.push(part.artifactId);
			}
			return ids;
		},
	});

	const processCall = async (call: LlmToolCall, sub: number): Promise<CallOutcome> => {
		const name = call.function.name;
		let args: Record<string, unknown> = {};
		try {
			args = parseArgs(call.function.arguments);
		} catch (error) {
			return await emitSynthetic(call, name, error instanceof Error ? error.message : "invalid arguments");
		}
		// Só executa o que o modelo viu. Tool adiada: carrega o grupo e o modelo repete já com o schema.
		if (!hasToolInRun(name) || !tools.some((tool) => tool.function.name === name)) {
			if (catalog.deferral?.isDeferred(name)) {
				const { notes } = catalog.deferral.loadGroupOf(name);
				return await emitSynthetic(call, name, `Tool ${name} was not loaded; it is loaded now. Call it again.${notes ? `\n${notes}` : ""}`, args);
			}
			return await emitSynthetic(call, name, unavailableToolMessage(name, Boolean(mcp?.toolset.available.has(name)), tools.some((tool) => tool.function.name === "mcp_tool_search")), args);
		}
		const blockedMessage = supervisor.toolBlocked(name, step);
		if (blockedMessage) return { ...(await emitSynthetic(call, name, blockedMessage, args)), blocked: true };

		const entry = entryOf(name);
		const idempotencyKey = toolIdempotencyKey({ runId, decisionIndex: step, toolCallId: call.id, toolName: name });
		await onEvent({ type: "tool_call", id: call.id, name, args: call.function.arguments, step });

		const replay = await params.findCompletedTool?.(idempotencyKey);
		if (replay) {
			await onEvent({ type: "tool_result", id: call.id, name, ok: replay.ok, summary: replay.summary });
			if (replay.file) {
				await persistConversationCardFromEvent(conversationId, replay.file).catch(() => undefined);
				await onEvent(replay.file);
			}
			return { call, name, ok: replay.ok, summary: replay.summary, args };
		}
		const journaled = isJournaledWrite(name, entry);
		if (journaled) {
			const started = await params.findStartedTool?.(idempotencyKey);
			if (started) {
				await onEvent({ type: "tool_result", id: call.id, name, ok: false, summary: INTERRUPTED_WRITE_NOTE });
				return { call, name, ok: false, summary: INTERRUPTED_WRITE_NOTE, args };
			}
		}
		const argsHash = journaled ? hashEffectArgs(args) : undefined;
		await params.onStep?.({
			decisionIndex: step,
			subIndex: sub + 1,
			type: "tool",
			status: "running",
			idempotencyKey,
			inputJson: { name, args, ...(journaled ? { attemptId: idempotencyKey, argsHash } : {}) },
		});
		toolCallCounts.set(name, (toolCallCounts.get(name) ?? 0) + 1);
		if (entry) catalog.pinMcpTool(name);

		let summary = "";
		let ok = true;
		let uncertain = false;
		let image: string | undefined;
		let visionArtifactIds: string[] = [];
		let pendingCard = false;
		let loginEvent: Extract<ComputerUseEvent, { type: "login" }> | undefined;
		let fileEvent: Extract<ComputerUseEvent, { type: "file" }> | undefined;
		const cards: ComputerUseEvent[] = [];
		const startedAt = Date.now();
		try {
			await ensureContinue();
			const outcome = await runSandboxOperation(executionContext, isSandboxTool(name) ? 180_000 : undefined, (signal) => executeTool(name, args, buildContext(call, signal)));
			if (isUntrustedContentTool(name) && !(isMcpToolName(name) && outcome.confirmEvent)) await markUntrusted();
			summary = outcome.summary;
			image = outcome.image;
			visionArtifactIds = outcome.visionArtifactIds ?? [];
			fileEvent = outcome.fileEvent;
			loginEvent = outcome.loginEvent;
			if (outcome.confirmEvent) {
				cards.push(outcome.confirmEvent);
				if ((outcome.confirmEvent.status ?? "pending") === "pending") { awaiting.kind = "confirm"; pendingCard = true; }
			}
			if (outcome.skillEvent) {
				cards.push(outcome.skillEvent);
				// Cartão só informativo (lista, "aprendi", detalhe): o run para, mas não espera decisão.
				if (outcome.skillEvent.learned !== true && ["listed", "created", "updated", "cleaned", "deleted", "shown"].includes(outcome.skillEvent.action)) awaiting.kind ??= "skill_card";
			}
			if (outcome.skillProposalEvent) {
				cards.push(outcome.skillProposalEvent);
				if ((outcome.skillProposalEvent.status ?? "pending") === "pending") awaiting.kind ??= "skill_card";
			}
			if (outcome.botProposalEvent) { cards.push(outcome.botProposalEvent); awaiting.kind ??= "skill_card"; }
			if (outcome.routineEvent) cards.push(outcome.routineEvent);
			if (outcome.questionnaireEvent) { cards.push(outcome.questionnaireEvent); awaiting.kind ??= "questionnaire"; }
			if (outcome.profileEvent) {
				cards.push(outcome.profileEvent);
				if ((outcome.profileEvent.status ?? "pending") === "pending") awaiting.kind ??= "profile";
			}
		} catch (error) {
			if (params.abortSignal?.aborted) throw errorFromAbortSignal(params.abortSignal);
			if (isControlFlowError(error)) throw error;
			ok = false;
			if (isUntrustedContentTool(name)) await markUntrusted();
			uncertain = error instanceof ToolEffectUncertainError;
			summary = error instanceof Error ? error.message : "erro";
			if (!isSandboxTool(name) && classifyToolFailure(summary) === "argument") summary = withArgumentErrorHint(summary);
		}
		const durationMs = Date.now() - startedAt;
		let imageArtifactId: string | undefined;
		if (image && params.persistScreenshot && image.startsWith("data:")) imageArtifactId = await params.persistScreenshot(image.replace(/^data:image\/\w+;base64,/, ""));
		await params.onStep?.({
			decisionIndex: step,
			subIndex: sub + 1,
			type: "tool_result",
			status: ok ? "completed" : "failed",
			idempotencyKey,
			durationMs,
			outputJson: {
				summary,
				ok,
				status: buildToolResultStatus({ ok, writes: journaled && !pendingCard, uncertain, code: uncertain ? "no_result" : ok ? undefined : "other" }),
				...(fileEvent ? { file: fileEvent } : {}),
				...(imageArtifactId ? { imageArtifactId } : {}),
			},
		});
		await onEvent({ type: "tool_result", id: call.id, name, ok, summary });
		for (const card of cards) await onEvent(card);
		if (loginEvent) {
			// Nesta fase o login é sempre do usuário (sem preenchimento automático do Cofre): o cartão vai sem a oferta.
			const { vault: _offer, ...human } = loginEvent;
			loginToAsk = human;
			await persistConversationCardFromEvent(conversationId, human).catch(() => undefined);
			await onEvent(human);
		}
		if (fileEvent) {
			await persistConversationCardFromEvent(conversationId, fileEvent).catch(() => undefined);
			await onEvent(fileEvent);
		}
		// Imagens só entram no contexto depois do resultado da tool (a ordem das mensagens é a das chamadas).
		pendingMedia.set(call.id, imageArtifactId ? [{ type: "screenshot_ref", artifactId: imageArtifactId }] : visionArtifactIds.length > 0 && canSeeImages ? visionArtifactIds.map((artifactId): LlmContentPart => ({ type: "screenshot_ref", artifactId })) : []);
		return { call, name, ok, summary, args };
	};
	const parallelSafe = (call: LlmToolCall): boolean => {
		const name = call.function.name;
		if (!tools.some((tool) => tool.function.name === name) || supervisor.toolBlocked(name, step)) return false;
		const entry = entryOf(name);
		if (entry) return entry.readOnly && decideAction(autonomyPolicy, entry.autonomyMeta) === "allow";
		return getToolRegistration(name)?.readOnly === true && !isSandboxTool(name) && name !== "update_task_list";
	};

	/** Roda o lote de tool calls do passo e devolve os resultados na ordem das chamadas. */
	const runBatch = async (calls: LlmToolCall[]): Promise<CallOutcome[]> => {
		if (calls.some((call) => isJournaledWrite(call.function.name, entryOf(call.function.name)))) await persistCheckpoint(step);
		const outcomes: CallOutcome[] = [];
		if (calls.length > 1 && calls.every(parallelSafe)) {
			for (let at = 0; at < calls.length; at += MAX_PARALLEL_READS) {
				const chunk = calls.slice(at, at + MAX_PARALLEL_READS);
				outcomes.push(...(await Promise.all(chunk.map((call, index) => processCall(call, at + index)))));
			}
			return outcomes;
		}
		for (const [index, call] of calls.entries()) {
			if (awaiting.kind || loginToAsk) {
				outcomes.push({ call, name: call.function.name, ok: false, summary: "Not executed: waiting for the user.", args: {}, skipped: true });
				continue;
			}
			outcomes.push(await processCall(call, index));
		}
		return outcomes;
	};

	/** Escreve os resultados no histórico, aplica o Supervisor e devolve o motivo de aborto por repetição, se houver. */
	const settleBatch = (outcomes: CallOutcome[]): RunStop | undefined => {
		let abort: RunStop | undefined;
		for (const outcome of outcomes) {
			conversation.push({ role: "tool", tool_call_id: outcome.call.id, content: outcome.summary });
			const media = pendingMedia.get(outcome.call.id);
			pendingMedia.delete(outcome.call.id);
			if (media && media.length > 0) conversation.push({ role: "user", content: [{ type: "text", text: "Screenshot atual da tela:" }, ...media] });
		}
		for (const outcome of outcomes) {
			if (outcome.blocked || outcome.skipped) continue;
			const verdict = supervisor.recordTool({
				step,
				name: outcome.name,
				argsKey: toolArgsKey(outcome.name, outcome.args),
				resultKey: toolResultKey(outcome.summary, outcome.ok),
				ok: outcome.ok,
				message: outcome.ok ? undefined : outcome.summary,
			});
			for (const note of verdict.notes) appendToLatestToolResult(conversation, note);
			abort ??= verdict.abort;
		}
		return abort;
	};

	/** Parada por cartão que espera o usuário, ou pausa por login. */
	const stopIfWaiting = async (): Promise<RunComputerUseResult | undefined> => {
		if (loginToAsk) {
			const ask = loginToAsk;
			loginToAsk = undefined;
			pendingLogin = { loginId: ask.loginId, site: ask.site, url: ask.url, ...(ask.reason === "captcha" ? { reason: "captcha" as const } : {}), ...(ask.composioToolkit ? { composioToolkit: ask.composioToolkit } : {}), ...(ask.connector ? { connector: ask.connector } : {}) };
			await persistCheckpoint(step);
			await params.onLoginRequired?.({ ...pendingLogin });
			throw new AgentRunPausedError("Aguardando o login do usuário");
		}
		if (awaiting.kind) {
			await persistCheckpoint(step);
			return { text: "", model: lastModel, hitWall: false, usage: usageTotals, stop: { reason: "awaiting_confirmation", detail: awaiting.kind } };
		}
		return undefined;
	};

	const finishOk = async (text: string, stop: RunStop, messageId: string): Promise<RunComputerUseResult> => {
		// Itens descartados e pendências vão na resposta; o delta mantém o balão ao vivo igual ao gravado.
		const items = currentTaskItems();
		const unresolved = stop.detail === "tasklist_open" ? openItems(items).map((item) => item.content) : [];
		const withNotes = appendUnconfirmed(text, { dropped: droppedItems(items), unresolved, language });
		if (withNotes !== text) await onEvent({ type: "assistant_delta", id: messageId, delta: withNotes.slice(text.length) });
		taskTracker.setPhase("done");
		await persistCheckpoint(step + 1);
		await checkpointTail;
		return { text: withNotes, model: lastModel, hitWall: false, usage: usageTotals, stop };
	};

	/** Última chamada SEM tools: entrega o que há, nunca aborta sem resposta. */
	const deliver = async (stop: RunStop, instruction: string): Promise<RunComputerUseResult> => {
		conversation.push({ role: "user", content: `${AUTO_CONTEXT} ${instruction}` });
		const messageId = `${turnId}-final`;
		let text = "";
		try {
			const final = await modelStep(conversation, "none", messageId, true);
			text = sanitizeAssistantText(final.content);
		} catch (error) {
			if (error instanceof AgentRunCancelledError || error instanceof AgentRunPausedError) throw error;
		}
		if (!text) {
			text = budgetStopFallbackText(stop.reason, language);
			await onEvent({ type: "assistant_delta", id: messageId, delta: text });
		}
		return await finishOk(text, stop, messageId);
	};

	// Observabilidade: quais tools o modelo viu neste run.
	void Promise.resolve(
		params.onStep?.({
			decisionIndex: 0,
			subIndex: OFFERED_TOOLS_SUB_INDEX,
			type: "checkpoint",
			status: "completed",
			idempotencyKey: `${runId}:offered-tools`,
			outputJson: { offeredTools: tools.map((tool) => tool.function.name), ...(catalog.deferral ? { deferredTools: catalog.deferral.pending() } : {}), engine: "v2", profile: options.profile },
		}),
	).catch(() => undefined);

	// Retomada no meio de um lote: as tool calls sem resultado rodam primeiro.
	const lastAssistant = [...conversation].reverse().find((message) => message.role === "assistant");
	let abortStop: RunStop | undefined;
	if (lastAssistant?.tool_calls?.length) {
		const answered = completedToolCallIds(conversation);
		const pending = lastAssistant.tool_calls.filter((call) => !answered.has(call.id));
		if (pending.length > 0) {
			abortStop = settleBatch(await runBatch(pending));
			step += 1;
			await persistCheckpoint(step);
			const waiting = await stopIfWaiting();
			if (waiting) return waiting;
		}
	}

	let finishRetries = 0;
	let emptyRetries = 0;
	let truncatedReply: { id: string; text: string } | undefined;
	try {
		for (;;) {
			await ensureContinue();
			await ensureNotPaused();
			if (abortStop) return await deliver(abortStop, deliveryInstruction("loop_repeat"));
			// Mensagens do usuário durante o run: viram nota; "cancelar" para o run.
			if (params.consumeSteerInputs) {
				for (const input of await params.consumeSteerInputs()) {
					if (consumedInputIds.has(input.id)) continue;
					if (input.mode === "cancel") throw new AgentRunCancelledError("Cancel solicitado via input");
					if (input.mode === "queue") continue;
					consumedInputIds.add(input.id);
					conversation.push({ role: "user", content: `[User message during the task] ${input.content}` });
					await onEvent({ type: "input_consumed", inputId: input.id, mode: input.mode ?? "join", content: input.content });
				}
			}
			const gate = supervisor.gate({ costUsd: usageTotals.costUsd ?? 0, activeMs: activeElapsedMs(), step });
			if (gate.action === "deliver") return await deliver(gate.stop, gate.instruction);
			if (gate.note && !appendToLatestToolResult(conversation, gate.note)) conversation.push({ role: "user", content: `${AUTO_CONTEXT} ${gate.note}` });

			await persistCheckpoint(step);
			const stepId = truncatedReply?.id ?? `${turnId}-step-${step}`;
			const outcome = await modelStep(conversation, "auto", stepId);
			const { content, toolCalls, providerItems, usage, result, telemetry } = outcome;
			const finishReason = result.finishReason;
			const text = truncatedReply && toolCalls.length === 0 ? `${truncatedReply.text}${sanitizeAssistantText(content)}` : sanitizeAssistantText(content);
			truncatedReply = undefined;
			await params.onStep?.({
				decisionIndex: step,
				subIndex: 0,
				type: "model",
				status: "completed",
				idempotencyKey: `${runId}:model:${step}`,
				tokens: usage.totalTokens,
				durationMs: telemetry.modelMs,
				telemetry,
				...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
				outputJson: { content: text, toolCallIds: toolCalls.map((call) => call.id), ...(finishReason ? { finishReason } : {}) },
			});

			if (toolCalls.length === 0) {
				// Resposta cortada pelo limite de saída ou stream incompleto não é conclusão: uma nova tentativa.
				const finishClass = classifyFinish(finishReason);
				if ((finishClass === "truncated" || finishClass === "incomplete") && finishRetries < 1) {
					finishRetries += 1;
					if (finishClass === "truncated" && text.length > 0) {
						conversation.push({ role: "assistant", content: text });
						conversation.push({ role: "user", content: `${AUTO_CONTEXT} ${TRUNCATED_REPLY_NOTE}` });
						truncatedReply = { id: stepId, text };
					}
					step += 1;
					continue;
				}
				if (text.length === 0) {
					if (emptyRetries < 1) {
						emptyRetries += 1;
						conversation.push({ role: "user", content: `${AUTO_CONTEXT} ${EMPTY_REPLY_NOTE}` });
						step += 1;
						continue;
					}
					await onEvent({ type: "assistant_delta", id: stepId, delta: EMPTY_REPLY_FALLBACK_TEXT });
					return await finishOk(EMPTY_REPLY_FALLBACK_TEXT, { reason: "answered", detail: "empty_reply" }, stepId);
				}
				// Lista de tarefas obrigatória em trabalho longo: sem itens abertos para entregar.
				const verdict = taskGate.check(currentTaskItems());
				if (verdict.kind === "note") {
					await onEvent({ type: "assistant_discard", id: stepId, reason: "items_open" });
					conversation.push({ role: "assistant", content: text });
					conversation.push({ role: "user", content: `${AUTO_CONTEXT} ${verdict.text}` });
					step += 1;
					continue;
				}
				const stop: RunStop = verdict.kind === "release" ? { reason: "answered", detail: "tasklist_open" } : { reason: "answered" };
				return await finishOk(text, stop, stepId);
			}

			finishRetries = 0;
			conversation.push({ role: "assistant", content: text.length > 0 ? text : null, tool_calls: toolCalls, ...(providerItems ? { providerItems } : {}) });
			const outcomes = await runBatch(toolCalls);
			abortStop = settleBatch(outcomes);
			step += 1;
			await persistCheckpoint(step);
			const waiting = await stopIfWaiting();
			if (waiting) return waiting;
			await params.onStep?.({ decisionIndex: step - 1, subIndex: 99, type: "checkpoint", status: "completed", idempotencyKey: `${runId}:checkpoint:${step - 1}` });
		}
	} finally {
		await checkpointTail;
	}
}
