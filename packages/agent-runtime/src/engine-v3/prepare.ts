import { randomBytes } from "node:crypto";
import { streamChatWithTools, type LlmContentPart, type LlmMessage } from "@workspace/llm";
import {
	DEFAULT_AUTONOMY_LEVEL,
	buildPersonaBlock,
	parseQuestionnaireAnsweredContent,
	resolveReplyLanguage,
	TRANSCRIPT_SLOT,
	type AgentRunCheckpoint,
	type EffectiveAutonomy,
} from "@workspace/shared";
import { getBotProfile, getConversationUntrustedAt, markConversationUntrusted, markMcpTaskGrantsUntrusted } from "@workspace/db";
import { loadSandboxConfig } from "@workspace/sandbox";
import { emptyUsage, resolveBudget, wallClockAnchors } from "../budget.js";
import { buildRuntimeCheckpoint, hydrateLlmMessages, parseRuntimeCheckpoint } from "../checkpoint.js";
import { connectorsPrompt } from "../connectors-prompt.js";
import { todayNote } from "../context/today-note.js";
import { isUnattendedOrigin } from "../autonomy-gate.js";
import { createPreToolRunner } from "../hooks/pre-tool-runner.js";
import { createSecretSession } from "../secrets/session.js";
import { createProviderHealth } from "../tools/provider-health.js";
import { isBotConfigEventObjective } from "../tools/registry/helpers.js";
import { shouldExposeSetEngine } from "../tools/set-engine.js";
import type { ComputerUseParams } from "../run-types.js";
import { buildEngineV2Catalog } from "../engine-v2/catalog.js";
import { buildEngineV2SystemPrompt } from "../engine-v2/prompt.js";
import { originSystemNotes } from "../engine-v2/origin-notes.js";
import { estimateCostUsd, fallbackPricesFromEnv } from "../engine-v2/cost.js";
import { parseV3State } from "./checkpoint.js";
import { stepLimitFor } from "./limits.js";
import { createNudges } from "./nudges.js";
import { applyCatalogPolicy, policyBase } from "./policy.js";
import { createRepetitionGuard } from "./repetition.js";
import type { V3Run } from "./state.js";

export type EngineV3Options = {
	/** Teto de passos que o DONO configurou (conta, bot ou pedido); ausente = 40 sem humano, 200 com humano. */
	ownerSteps?: number;
};

/**
 * PREPARE (desenho 2.1): carrega bot, política, catálogo, prompt e checkpoint. Sem chamada extra de LLM.
 * Por ora o prompt e o catálogo são os do v2 (o prompt de 3 blocos e a ponte `tool_search/tool_call` são o PR5); a
 * política v3 tira do catálogo o que esconde.
 */
export async function prepareRun(params: ComputerUseParams, options: EngineV3Options): Promise<{ run: V3Run; restored: AgentRunCheckpoint | null }> {
	const parsed = parseRuntimeCheckpoint(params.restoredCheckpoint);
	const runId = params.runId ?? "local";
	const userId = params.userId ?? "default";
	const origin = params.origin ?? "chat";
	const lastUserMessage = [...params.messages].reverse().find((message) => message.role === "user")?.content ?? "";
	const directHumanTurn =
		params.humanTurn === true && !isBotConfigEventObjective(params.objective ?? "") && !isBotConfigEventObjective(lastUserMessage) && !parseQuestionnaireAnsweredContent(lastUserMessage);
	const humanTurn = origin === "subagent" ? params.parentHumanTurn === true : directHumanTurn;
	const policy = policyBase({ origin, ...(params.parentOrigin ? { parentOrigin: params.parentOrigin } : {}), humanTurn, planPending: Boolean(params.planPending) });
	const canAsk = policy.humanPresent && humanTurn && origin !== "subagent";
	// Limite de passos: chat com pessoa (inclui resposta de questionário/cartão, que a política não conta como turno humano
	// para aprovar) não tem o teto de 40; só origem sem ninguém olhando tem.
	const personWatching = policy.humanPresent && (params.humanTurn === true || params.parentHumanTurn === true);
	const unattended = isUnattendedOrigin(origin);
	const botProfile = params.botId ? await (params.loadBotProfile ?? getBotProfile)(params.botId, params.userId).catch(() => null) : null;
	const replyLanguage = resolveReplyLanguage({ setting: params.language ?? "pt-BR", ...params.languageContext, hasUserMessage: origin === "chat" });
	let autonomy: EffectiveAutonomy = params.autonomy ?? { level: DEFAULT_AUTONOMY_LEVEL, exceptions: [] };
	const mcp = params.mcp ?? null;
	const sandboxEnabled = (params.sandboxEnabled ?? true) && loadSandboxConfig().enabled;
	const botCount =
		params.listBotRoster && params.botId && userId !== "default" && (origin === "chat" || origin === "bot") ? (await params.listBotRoster(userId).catch(() => [])).length : 0;
	const imageIds = params.userImageArtifactIds ?? parsed?.userImageArtifactIds ?? [];

	const catalog = buildEngineV2Catalog({
		origin,
		...(params.parentOrigin ? { policyParentOrigin: params.parentOrigin } : {}),
		policyHumanTurn: humanTurn,
		userId,
		sandboxEnabled,
		autonomy,
		toolFilter: params.toolFilter,
		mcp,
		apiConnector: Boolean(params.apiConnector),
		email: params.email,
		attachments: { present: params.attachments?.present === true },
		planMode: params.planMode,
		allowProfileUpdate: origin === "chat" && (!botProfile?.description?.trim() || isBotConfigEventObjective(params.objective ?? "") || isBotConfigEventObjective(lastUserMessage)),
		hasImageAttachments: imageIds.length > 0,
		routerMessages: params.messages,
		lastUserMessage,
		objective: params.objective,
		priorLoadedTools: params.priorLoadedTools ?? parsed?.loadedTools,
		setEngine: shouldExposeSetEngine({ origin, humanTurn, lastUserMessage }),
		botMessaging: { botCount, decideForOtherBots: params.decideForOtherBots === true },
		...(origin === "routine" && params.routinePageId ? { routinePageId: params.routinePageId } : {}),
		...(params.proactive ? { proactive: { hasConversation: Boolean(params.conversationId) } } : {}),
		...(params.userPush && (origin === "routine" || origin === "chat") ? { userPush: params.userPush.mode } : {}),
		...(origin === "routine" && params.alertRun ? { alertRun: true } : {}),
	});
	const entryOf = (name: string) => mcp?.toolset.entries.get(name);
	applyCatalogPolicy(catalog.tools, { base: policy, autonomy, entryOf });
	const tools = catalog.tools;
	const hasTool = (name: string) => tools.some((tool) => tool.function.name === name) || Boolean(catalog.deferral?.isDeferred(name));

	// --- conversa ---
	let conversation: LlmMessage[];
	if (parsed?.llmMessages?.length) {
		conversation = await hydrateLlmMessages(parsed.llmMessages);
	} else {
		const system = buildEngineV2SystemPrompt({
			persona: buildPersonaBlock({ name: botProfile?.name, role: botProfile?.description, language: params.language ?? "pt-BR" }),
			profile: "chat",
			model: params.model,
			connectors: mcp && mcp.toolset.entries.size > 0 ? `\n\n${connectorsPrompt(mcp.toolset)}` : "",
			skillIndex: params.skillIndex,
			toolIndex: catalog.index,
			preloadedGroups: catalog.preloaded,
			atlasUrl: process.env.ATLAS_URL,
			taskList: hasTool("update_task_list"),
			...(unattended ? { unattended: true } : {}),
			...(origin === "routine" ? { routine: true } : {}),
			...(origin === "email" && hasTool("email_reply") ? { emailRun: true } : {}),
			languageInstruction: replyLanguage.instruction,
		});
		const priorHistory = params.priorTranscript?.length ? await hydrateLlmMessages(params.priorTranscript) : [];
		const base = params.messages.map((message) => ({ role: message.role, content: message.content }) as LlmMessage);
		const slot = base.findIndex((message) => message.role === "system" && message.content === TRANSCRIPT_SLOT);
		const placed = slot < 0 ? base : [...base.slice(0, slot), ...priorHistory, ...base.slice(slot + 1)];
		const notes = originSystemNotes({ origin, messages: params.messages, proactive: params.proactive ?? null, userPushMode: params.userPush?.mode, alertRun: params.alertRun });
		const now = process.env.ATLAS_NOW_NOTE === "off" ? [] : [todayNote(new Date(), params.timeZone)];
		// Tudo o que é `system` entra só aqui, no começo do run; no meio do run o runtime fala por `user` com `[runtime]`.
		conversation = [{ role: "system", content: system }, ...[...notes, ...now].map((content) => ({ role: "system" as const, content })), ...placed];
		const lastUser = [...conversation].reverse().find((message) => message.role === "user");
		if (lastUser && (imageIds.length > 0 || params.attachments?.turnContext)) {
			const parts: LlmContentPart[] = typeof lastUser.content === "string" ? [{ type: "text", text: lastUser.content }] : Array.isArray(lastUser.content) ? lastUser.content : [];
			lastUser.content = [
				...parts,
				...imageIds.slice(0, 4).map((artifactId) => ({ type: "image_ref" as const, artifactId })),
				...(params.attachments?.turnContext ? [{ type: "text" as const, text: params.attachments.turnContext }] : []),
				...(params.attachments?.nativePdfs ?? []).map((pdf) => ({ type: "file_ref" as const, artifactId: pdf.id, filename: pdf.filename })),
			];
		}
	}

	// --- orçamento: só tetos do dono; passos pela regra do desenho ---
	const limits = resolveBudget({ maxSteps: params.maxSteps, policy: params.budget });
	const wall = wallClockAnchors({ maxWallMs: limits.maxWallMs, now: Date.now(), runStartedAt: params.runStartedAt, restored: parsed });
	const prices = fallbackPricesFromEnv();
	const usage = parsed?.usageTotals ? { ...emptyUsage(), ...parsed.usageTotals } : emptyUsage();
	const v3State = parseV3State(parsed?.engineV3);

	const secrets = params.userId ? createSecretSession({ userId: params.userId, by: () => ({ actor: "bot", botId: params.botId, conversationId: params.conversationId }) }) : undefined;
	let untrustedRead: Promise<boolean> | undefined;
	const conversationUntrusted = () =>
		(untrustedRead ??= userId && params.conversationId ? getConversationUntrustedAt({ userId, conversationId: params.conversationId }).then((at) => at !== null, () => true) : Promise.resolve(false));
	let marked = false;
	let checkpointTail: Promise<void> = Promise.resolve();

	const run: V3Run = {
		params,
		runId,
		userId,
		...(params.botId ? { botId: params.botId } : {}),
		...(params.conversationId ? { conversationId: params.conversationId } : {}),
		origin,
		humanTurn,
		canAsk,
		unattended,
		personWatching,
		language: replyLanguage.language,
		model: params.model,
		lastModel: parsed?.model ?? params.model,
		turnId: `t${Date.now().toString(36)}${randomBytes(4).toString("hex")}`,
		...(parsed?.transcriptSeed?.fromRunId ? { continuesRunId: parsed.transcriptSeed.fromRunId } : {}),
		catalog,
		tools,
		entryOf,
		hasTool,
		conversation,
		policy,
		autonomy: { get: () => autonomy, set: (next) => { autonomy = next; } },
		preTools: createPreToolRunner({
			lessons: params.lessons?.items,
			preToolRules: params.preToolRules,
			planPending: Boolean(params.planPending),
			toolset: mcp?.toolset,
			loadedToolNames: () => tools.map((tool) => tool.function.name),
			onInspect: params.onInspect,
			recordFeedback: params.lessons?.recordFeedback,
			confirmNative: true,
		}),
		...(secrets ? { secrets } : {}),
		health: params.providerHealth ?? createProviderHealth(),
		limit: stepLimitFor({ humanPresent: personWatching, ...(options.ownerSteps !== undefined ? { ownerSteps: options.ownerSteps } : {}) }),
		step: parsed?.nextStepIndex ?? 0,
		usage,
		estimatedCostUsd: usage.costUsd === undefined && (usage.costUnknownCalls ?? 0) > 0 ? estimateCostUsd(usage, prices) : 0,
		spentUsd: () => (run.usage.costUsd ?? 0) + run.estimatedCostUsd,
		activeMs: () => wall.baseMs + (Date.now() - wall.executionStartMs),
		nudges: createNudges(v3State.nudges),
		repetition: createRepetitionGuard(v3State.repetition),
		...(v3State.ownTaskList ? { ownTaskList: v3State.ownTaskList, taskListItems: v3State.ownTaskList } : {}),
		loginAsked: new Set(parsed?.loginAsked ?? []),
		...(parsed?.pendingLogin ? { pendingLogin: parsed.pendingLogin } : {}),
		consumedInputIds: new Set(parsed?.consumedInputIds ?? []),
		pendingSteer: [],
		toolCallCounts: new Map(Object.entries(parsed?.toolCallCounts ?? {})),
		mcpRun: { untrustedSeen: parsed?.untrustedSeen === true, executed: [], conversationUntrusted },
		markUntrusted: async () => {
			run.mcpRun.untrustedSeen = true;
			if (marked || !params.userId || !params.conversationId) return;
			marked = true;
			const scope = { userId: params.userId, conversationId: params.conversationId };
			await Promise.all([markConversationUntrusted(scope), markMcpTaskGrantsUntrusted(scope)]).catch(() => { marked = false; });
		},
		shown: { images: parsed?.shownImageCount ?? 0 },
		emit: async (event) => { await params.onEvent(event); },
		persistCheckpoint: (stepIndex = run.step) => {
			if (!params.onCheckpoint) return Promise.resolve();
			const snapshot = buildRuntimeCheckpoint({
				messages: params.messages,
				conversation: run.conversation,
				userImageArtifactIds: imageIds,
				shownImageCount: run.shown.images,
				nextStepIndex: stepIndex,
				model: run.lastModel,
				consumedInputIds: [...run.consumedInputIds],
				usageTotals: run.usage,
				toolCallCounts: Object.fromEntries(run.toolCallCounts),
				loginAsked: [...run.loginAsked],
				untrustedSeen: run.mcpRun.untrustedSeen,
				pendingLogin: run.pendingLogin,
				activeElapsedMs: run.activeMs(),
				loadedTools: run.tools.map((tool) => tool.function.name),
				transcriptWatermark: parsed?.transcriptWatermark ?? params.transcriptWatermark,
				carriedNotes: parsed?.carriedNotes ?? params.carriedNotes,
				recoveries: parsed?.recoveries,
				recoveredAtStep: parsed?.recoveredAtStep,
				engine: "v3",
				engineV3: { nudges: run.nudges.snapshot(), repetition: run.repetition.snapshot(), ...(run.ownTaskList ? { ownTaskList: run.ownTaskList } : {}) },
			});
			const write = checkpointTail.then(() => params.onCheckpoint!(snapshot));
			checkpointTail = write.catch(() => undefined);
			return write;
		},
		flushCheckpoints: () => checkpointTail,
	};
	return { run, restored: parsed };
}
