import { randomBytes } from "node:crypto";
import type { LlmMessage } from "@workspace/llm";
import {
	DEFAULT_AUTONOMY_LEVEL,
	buildPersonaBlock,
	createNotebook,
	dismissedDraftsNote,
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
import { todayNote } from "../context/today-note.js";
import { isUnattendedOrigin } from "../autonomy-gate.js";
import { createPreToolRunner } from "../hooks/pre-tool-runner.js";
import { createSecretSession } from "../secrets/session.js";
import { createProviderHealth } from "../tools/provider-health.js";
import { isBotConfigEventObjective } from "../tools/registry/helpers.js";
import { shouldExposeSetEngine } from "../tools/set-engine.js";
import type { ComputerUseParams } from "../run-types.js";
import { eligibleNativeTools, mcpToolVisible } from "../engine-v2/catalog.js";
import { originSystemNotes } from "../engine-v2/origin-notes.js";
import { estimateCostUsd, fallbackPricesFromEnv } from "../engine-v2/cost.js";
import { parseV3State } from "./checkpoint.js";
import { stepLimitFor } from "./limits.js";
import { createNudges } from "./nudges.js";
import { V3_BROWSER_HANDLERS, swapBrowserTools } from "../tools/browser-v3/index.js";
import { buildV3Catalog, connectorEntries } from "./catalog.js";
import { applyCatalogPolicy, catalogHides, policyBase } from "./policy.js";
import { assembleV3Conversation, attachToLastUser, buildV3ContextBlock, buildV3SystemPrompt } from "./prompt.js";
import { createRepetitionGuard } from "./repetition.js";
import { pendingReturnsTurnNote } from "./owner-wait.js";
import { OWNER_WAIT_DEFINED } from "../tools/registry/handlers/owner-wait.js";
import { ROUTINE_LIMITS_DEFINED } from "../tools/routine-limits.js";
import { PREPARE_FOR_OWNER_DEFINED } from "../tools/prepare-for-owner.js";
import { heldBackTools } from "./prepared.js";
import { priorWorkContext } from "./prior-work.js";

const ownerWaitTools = () => OWNER_WAIT_DEFINED.flatMap((tool) => (tool.definition ? [tool.definition] : []));
import type { V3Run } from "./state.js";

/** Até 300 tools, as mais usadas (o que vai e volta pelo checkpoint é exatamente o que montou o catálogo). */
function frozenUsage(raw: Readonly<Record<string, number>>): Record<string, number> {
	return Object.fromEntries(
		Object.entries(raw)
			.filter(([name, count]) => name.length > 0 && name.length <= 128 && Number.isInteger(count) && count > 0)
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, 300),
	);
}

export type EngineV3Options = {
	/** Teto de passos que o DONO configurou (conta, bot ou pedido); ausente = 40 sem humano, 200 com humano. */
	ownerSteps?: number;
	/** Perfil de trabalho longo do bot (o mesmo `long_work` do v2): o caderno da tarefa entra no catálogo (PR8e). */
	longWork?: boolean;
};

/**
 * PREPARE (desenho 2.1): carrega bot, política, catálogo, prompt e checkpoint. Sem chamada extra de LLM.
 * Catálogo = núcleo + ponte no array e o resto no manifesto (o que existe é o mesmo do v2: `eligibleNativeTools`);
 * a política tira dos dois o que esconde. Prompt em 3 blocos (`prompt.ts`).
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
	// Caderno (PR8e), como no v2: só no trabalho longo, fora do subagente. Fora dele nada muda (o "Bom dia" fica igual).
	const longWork = options.longWork === true && origin !== "subagent";
	const continuation = origin === "chat" && (params.autoContinued === true || params.continuedWork === true);
	const notebook = longWork ? createNotebook(parsed?.notebook ?? (continuation ? params.priorNotebook : undefined)) : undefined;
	// Só em run novo (retomada já tem a conversa e a lista no checkpoint); subagente não herda a tarefa da conversa.
	const priorWork = parsed || origin === "subagent" ? { note: "" } : priorWorkContext(params);

	// As ~10 tools de navegador do v1/v2 viram 4 (desenho 5); o resto do catálogo é o mesmo.
	const natives = swapBrowserTools(eligibleNativeTools({
		origin,
		userId,
		sandboxEnabled,
		autonomy,
		toolFilter: params.toolFilter,
		apiConnector: Boolean(params.apiConnector),
		email: params.email,
		attachments: { present: params.attachments?.present === true },
		longWork,
		allowProfileUpdate: origin === "chat" && (!botProfile?.description?.trim() || isBotConfigEventObjective(params.objective ?? "") || isBotConfigEventObjective(lastUserMessage)),
		setEngine: shouldExposeSetEngine({ origin, humanTurn, lastUserMessage }),
		botMessaging: { botCount, decideForOtherBots: params.decideForOtherBots === true },
		...(origin === "routine" && params.routinePageId ? { routinePageId: params.routinePageId } : {}),
		...(params.proactive ? { proactive: { hasConversation: Boolean(params.conversationId) } } : {}),
		...(params.userPush && (origin === "routine" || origin === "chat") ? { userPush: params.userPush.mode } : {}),
		...(origin === "routine" && params.alertRun ? { alertRun: true } : {}),
	}));
	// Só no v3 (PR8a): "Volto depois" precisa das filas, de uma conversa e de um dono; subagente não agenda.
	if (params.ownerWait && params.conversationId && userId !== "default" && origin !== "subagent") {
		for (const tool of ownerWaitTools()) if (params.toolFilter?.(tool.function.name) ?? true) natives.push(tool);
	}
	// Só no v3 (PR8b, D4): o dono muda os limites da rotina pelo chat. `needsHuman`: sem pessoa a política a esconde
	// (a rotina nunca sobe o próprio teto).
	if (origin === "chat" && params.botId && userId !== "default" && (params.toolFilter?.(ROUTINE_LIMITS_DEFINED.name) ?? true) && ROUTINE_LIMITS_DEFINED.definition) {
		natives.push(ROUTINE_LIMITS_DEFINED.definition);
	}
	// Só no v3 (PR8b, desenho 7 regra 1): sem pessoa (rotina, webhook, proativo, e-mail recebido, outro bot), o que
	// precisa do dono vira rascunho aprovável no chat dele. Subagente não posta cartão.
	const canPrepareForOwner = !policy.humanPresent && origin !== "subagent" && Boolean(params.conversationId) && userId !== "default";
	if (canPrepareForOwner && PREPARE_FOR_OWNER_DEFINED.definition && (params.toolFilter?.(PREPARE_FOR_OWNER_DEFINED.name) ?? true)) natives.push(PREPARE_FOR_OWNER_DEFINED.definition);
	const entryOf = (name: string) => mcp?.toolset.entries.get(name);
	const hides = (name: string) => catalogHides({ name, entry: entryOf(name), base: policy, autonomy });
	// Filtro do run (brief "Seu dia", conferência, ajudante): vale para nativa E conector, como no v2.
	const allow = (name: string) => params.toolFilter?.(name) ?? true;
	const connectorVisible = (name: string) => {
		const entry = entryOf(name);
		return Boolean(entry) && allow(name) && mcpToolVisible({ origin, autonomy, entry: entry! }) && !hides(name);
	};
	// Conector como alvo do rascunho (PR8e): só quando há rascunho possível; a escrita visível roda direto.
	const heldBack = heldBackTools(natives, hides, canPrepareForOwner ? { mcp, autonomy, allow, visible: connectorVisible } : undefined);
	// Catálogo congelado por conversa: o núcleo e o uso do run anterior (retomada ou turno seguinte) voltam iguais, então
	// manifesto e busca saem com os mesmos bytes; o uso do bot só é lido de novo em conversa nova.
	const v3State = parseV3State(parsed?.engineV3);
	const frozen = parsed?.loadedTools ?? params.priorLoadedTools;
	const toolUsage = frozenUsage(
		frozen?.length ? (v3State.toolUsage ?? params.priorToolUsage ?? {}) : ((await params.loadToolUsage?.().catch(() => ({}))) ?? {}),
	);
	const catalog = buildV3Catalog({
		natives,
		connectors: connectorEntries(mcp, connectorVisible),
		visible: (name) => !hides(name),
		vm: sandboxEnabled,
		...(frozen?.length ? { frozen } : {}),
		usage: toolUsage,
	});
	const tools = catalog.tools;
	applyCatalogPolicy(tools, { base: policy, autonomy, entryOf });
	const hasTool = (name: string) => catalog.entries.has(name);

	// --- conversa: system estável, contexto, histórico, volátil e a fala atual ---
	let conversation: LlmMessage[];
	if (parsed?.llmMessages?.length) {
		conversation = await hydrateLlmMessages(parsed.llmMessages);
	} else {
		const system = buildV3SystemPrompt({
			persona: buildPersonaBlock({ name: botProfile?.name, role: botProfile?.description, language: params.language ?? "pt-BR" }),
			model: params.model,
			bridge: catalog.deferred.length > 0,
			...(unattended ? { unattended: true } : {}),
			...(origin === "routine" ? { routine: true } : {}),
			...(origin === "email" && hasTool("email_reply") ? { emailRun: true } : {}),
			languageInstruction: replyLanguage.instruction,
		});
		const priorHistory = params.priorTranscript?.length ? await hydrateLlmMessages(params.priorTranscript) : [];
		const notes = originSystemNotes({ origin, messages: params.messages, proactive: params.proactive ?? null, userPushMode: params.userPush?.mode, alertRun: params.alertRun });
		const now = process.env.ATLAS_NOW_NOTE === "off" ? [] : [todayNote(new Date(), params.timeZone)];
		// Retorno agendado ainda pendente: o modelo vê e não agenda de novo nem faz duas vezes (desenho "Volto depois").
		// Itens abertos do run anterior (mensagem digitada) ou a lista que segue com a tarefa (continuação automática, plano).
		if (priorWork.note) notes.push(priorWork.note);
		// Continuação de trabalho longo: o índice do caderno herdado (títulos, não o conteúdo; o resto por `notebook_read`).
		const notebookIndex = notebook?.index();
		if (notebookIndex) notes.push(notebookIndex);
		const returns = params.ownerWait ? await pendingReturnsTurnNote(params) : "";
		if (returns) notes.push(returns);
		// Rascunho que o dono descartou ("Agora não"): nota interna, nunca balão (decisão do dono, 04/11). Uma vez só.
		const dismissed = params.loadDismissedDrafts && params.conversationId && userId !== "default" && origin !== "subagent" ? dismissedDraftsNote(await params.loadDismissedDrafts().catch(() => [])) : "";
		if (dismissed) notes.push(dismissed);
		conversation = assembleV3Conversation({
			system,
			contextFor: (snapshot) => buildV3ContextBlock({ manifest: catalog.manifest, skillIndex: params.skillIndex, canReadSkills: hasTool("skill_read"), snapshot }),
			messages: params.messages,
			priorHistory,
			slot: TRANSCRIPT_SLOT,
			volatile: [...now, ...notes],
		});
		attachToLastUser(conversation, { imageIds, turnContext: params.attachments?.turnContext, pdfs: params.attachments?.nativePdfs });
	}

	// --- orçamento: só tetos do dono; passos pela regra do desenho ---
	// Rotina (D4): passos e US$ próprios valem só na origem `routine`; US$ = o menor entre o da conta/bot e o da rotina.
	const routineLimits = origin === "routine" ? params.routineLimits : undefined;
	const costCaps = [params.budget?.maxCostUsd, routineLimits?.maxCostUsd].filter((cap): cap is number => typeof cap === "number" && Number.isFinite(cap) && cap > 0);
	const costCapUsd = costCaps.length > 0 ? Math.min(...costCaps) : undefined;
	const limits = resolveBudget({ maxSteps: params.maxSteps, policy: params.budget });
	const wall = wallClockAnchors({ maxWallMs: limits.maxWallMs, now: Date.now(), runStartedAt: params.runStartedAt, restored: parsed });
	const prices = fallbackPricesFromEnv();
	const usage = parsed?.usageTotals ? { ...emptyUsage(), ...parsed.usageTotals } : emptyUsage();

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
		languageInstruction: replyLanguage.instruction,
		model: params.model,
		lastModel: parsed?.model ?? params.model,
		turnId: `t${Date.now().toString(36)}${randomBytes(4).toString("hex")}`,
		...(parsed?.transcriptSeed?.fromRunId ? { continuesRunId: parsed.transcriptSeed.fromRunId } : {}),
		catalog,
		tools,
		toolUsage,
		toolHandlers: V3_BROWSER_HANDLERS,
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
		limit: stepLimitFor({
			humanPresent: personWatching,
			...(options.ownerSteps !== undefined ? { ownerSteps: options.ownerSteps } : {}),
			...(routineLimits?.maxSteps !== undefined ? { routineSteps: routineLimits.maxSteps } : {}),
		}),
		...(costCapUsd !== undefined ? { costCapUsd } : {}),
		limitGrant: v3State.limitGrant ?? { steps: 0, usd: 0, waits: 0 },
		...(v3State.limitWait ? { limitWait: v3State.limitWait } : {}),
		heldBack,
		canPrepareForOwner: canPrepareForOwner && catalog.entries.has(PREPARE_FOR_OWNER_DEFINED.name),
		draftsPrepared: v3State.draftsPrepared ?? 0,
		step: parsed?.nextStepIndex ?? 0,
		usage,
		estimatedCostUsd: usage.costUsd === undefined && (usage.costUnknownCalls ?? 0) > 0 ? estimateCostUsd(usage, prices) : 0,
		spentUsd: () => (run.usage.costUsd ?? 0) + run.estimatedCostUsd,
		activeMs: () => wall.baseMs + (Date.now() - wall.executionStartMs),
		nudges: createNudges(v3State.nudges),
		repetition: createRepetitionGuard(v3State.repetition),
		...(v3State.ownTaskList ? { ownTaskList: v3State.ownTaskList, taskListItems: v3State.ownTaskList } : priorWork.seed ? { taskListItems: priorWork.seed } : {}),
		...(notebook ? { notebook } : {}),
		loginAsked: new Set(parsed?.loginAsked ?? []),
		ownerRefused: new Set([...(v3State.ownerRefused ?? []), ...(parsed?.transcriptSeed?.refused ?? [])]),
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
				...(run.notebook && run.notebook.count() > 0 ? { notebook: run.notebook.snapshot() } : {}),
				loadedTools: [...run.catalog.core],
				transcriptWatermark: parsed?.transcriptWatermark ?? params.transcriptWatermark,
				carriedNotes: parsed?.carriedNotes ?? params.carriedNotes,
				recoveries: parsed?.recoveries,
				recoveredAtStep: parsed?.recoveredAtStep,
				engine: "v3",
				engineV3: {
					nudges: run.nudges.snapshot(),
					repetition: run.repetition.snapshot(),
					...(run.ownTaskList ? { ownTaskList: run.ownTaskList } : {}),
					...(Object.keys(run.toolUsage).length > 0 ? { toolUsage: run.toolUsage } : {}),
					...(run.ownerRefused.size > 0 ? { ownerRefused: [...run.ownerRefused].slice(-50) } : {}),
					...(run.limitWait ? { limitWait: run.limitWait } : {}),
					...(run.limitGrant.steps > 0 || run.limitGrant.usd > 0 || run.limitGrant.waits > 0 ? { limitGrant: run.limitGrant } : {}),
					...(run.draftsPrepared > 0 ? { draftsPrepared: run.draftsPrepared } : {}),
				},
			});
			const write = checkpointTail.then(() => params.onCheckpoint!(snapshot));
			checkpointTail = write.catch(() => undefined);
			return write;
		},
		flushCheckpoints: () => checkpointTail,
	};
	return { run, restored: parsed };
}
