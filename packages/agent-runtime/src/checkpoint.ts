import type {
	AgentRunCheckpoint,
	ModelTier,
	SerializedLlmContentPart,
	SerializedLlmMessage,
} from "@workspace/shared";
import {
	AGENT_RUNTIME_CHECKPOINT_VERSION,
	MODEL_TIERS,
	parseCapabilitySnapshot,
	parseLoginConnector,
	parseLoginVaultOffer,
	parseTaskList,
	parseTaskState,
	parseToolCacheState,
} from "@workspace/shared";
import type { LlmContentPart, LlmMessage } from "@workspace/llm";
import { TOOL_CALL_HISTORY_SIZE } from "./tool-budget.js";
import { parseLedgerState } from "./execution/ledger.js";
import { parseResearchNotes } from "./tools/research-note.js";

const ARTIFACT_PREFIX = "artifact:";

export function isDataUrl(value: string): boolean {
	return value.startsWith("data:");
}

export function artifactRefUrl(artifactId: string): string {
	return `${ARTIFACT_PREFIX}${artifactId}`;
}

export function parseArtifactRef(url: string): string | null {
	if (!url.startsWith(ARTIFACT_PREFIX)) return null;
	const id = url.slice(ARTIFACT_PREFIX.length).trim();
	return id.length > 0 ? id : null;
}

function serializeContentPart(
	part: LlmContentPart | SerializedLlmContentPart,
): SerializedLlmContentPart {
	if (part.type === "text") return part;
	if (part.type === "screenshot_ref" || part.type === "image_ref" || part.type === "file_ref") return part;
	// Documento já expandido (Data URL base64): nunca vai para o checkpoint.
	if (part.type === "file") return { type: "text", text: "[documento omitido do checkpoint]" };
	const url = part.image_url.url;
	const artifactId = parseArtifactRef(url);
	if (artifactId) {
		return { type: "screenshot_ref", artifactId };
	}
	if (isDataUrl(url)) {
		// Checkpoints antigos (ou fora do fluxo) podem conter Data URL direto.
		// Degradar em vez de explodir o run: a imagem se perde, o progresso não.
		return { type: "text", text: "[screenshot omitido do checkpoint]" };
	}
	return part;
}

function parseProviderItems(
	value: unknown,
): SerializedLlmMessage["providerItems"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.provider !== "chatgpt" ||
		typeof record.model !== "string" ||
		!record.model.trim() ||
		!Array.isArray(record.items)
	) return undefined;
	const items: Record<string, unknown>[] = [];
	for (const item of record.items) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
		const entry = item as Record<string, unknown>;
		if (!["reasoning", "function_call", "message"].includes(String(entry.type))) {
			return undefined;
		}
		items.push(entry);
	}
	return { provider: "chatgpt", model: record.model, items };
}

function providerHistory(
	value: unknown,
): Pick<SerializedLlmMessage, "providerItems"> {
	const providerItems = parseProviderItems(value);
	return providerItems ? { providerItems } : {};
}

export function serializeLlmMessages(
	messages: LlmMessage[],
): SerializedLlmMessage[] {
	return messages.map((message) => ({
		role: message.role,
		content: Array.isArray(message.content)
			? message.content.map(serializeContentPart)
			: message.content,
		tool_calls: message.tool_calls,
		tool_call_id: message.tool_call_id,
		...providerHistory(message.providerItems),
	}));
}

/**
 * Normaliza mensagens armazenadas para a forma canônica de MEMÓRIA:
 * screenshots sempre como `screenshot_ref`, nunca Data URL nem
 * `image_url` com `artifact:`. Não expande nada — a expansão para o modelo
 * acontece só em `resolveLlmMessagesForModel`, na hora da chamada.
 */
export async function hydrateLlmMessages(
	messages: SerializedLlmMessage[],
): Promise<LlmMessage[]> {
	const hydrated: LlmMessage[] = [];
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			hydrated.push({
				role: message.role,
				content: message.content,
				tool_calls: message.tool_calls,
				tool_call_id: message.tool_call_id,
				...providerHistory(message.providerItems),
			});
			continue;
		}

		const parts: LlmContentPart[] = [];
		for (const part of message.content) {
			if (part.type === "text") {
				parts.push(part);
				continue;
			}
			if (part.type === "screenshot_ref" || part.type === "image_ref" || part.type === "file_ref") {
				parts.push(part);
				continue;
			}
			const artifactId = parseArtifactRef(part.image_url.url);
			if (artifactId) {
				parts.push({ type: "screenshot_ref", artifactId });
				continue;
			}
			if (isDataUrl(part.image_url.url)) {
				parts.push({
					type: "text",
					text: "[screenshot omitido do checkpoint]",
				});
				continue;
			}
			parts.push(part);
		}

		hydrated.push({
			role: message.role,
			content: parts,
			tool_calls: message.tool_calls,
			tool_call_id: message.tool_call_id,
			...providerHistory(message.providerItems),
		});
	}
	return hydrated;
}

/**
 * Expande a forma canônica para a forma de TRANSPORTE do modelo:
 * `screenshot_ref` vira `image_url` com Data URL (ou texto placeholder se o
 * artefato sumiu). O array canônico NÃO é mutado.
 */
export async function resolveLlmMessagesForModel(
	messages: LlmMessage[],
	loadScreenshot?: (artifactId: string) => Promise<string | null>,
	options?: {
		canSeeUserImages?: boolean;
		canSeeScreenshots?: boolean;
		loadUserImage?: (artifactId: string) => Promise<string | null>;
		describeUserImage?: (artifactId: string) => Promise<string | null>;
		/** O provedor lê PDF como documento; sem isso o PDF vira um aviso para usar attachment_read. */
		canReadNativePdf?: boolean;
		loadUserPdf?: (artifactId: string) => Promise<string | null>;
	},
): Promise<LlmMessage[]> {
	const resolved: LlmMessage[] = [];
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			resolved.push({ ...message });
			continue;
		}
		const parts: LlmContentPart[] = [];
		for (const part of message.content) {
			if (part.type === "image_ref") {
				if (options?.canSeeUserImages) {
					const dataUrl = await options.loadUserImage?.(part.artifactId);
					parts.push(dataUrl ? { type: "image_url", image_url: { url: dataUrl } } : { type: "text", text: "[the user attached an image, but it is unavailable]" });
				} else {
					const description = await options?.describeUserImage?.(part.artifactId);
					parts.push({ type: "text", text: description ? `[image attached by the user; description by a vision helper: ${description}]` : "[the user attached an image, but this model cannot see images]" });
				}
				continue;
			}
			if (part.type === "file_ref") {
				const dataUrl = options?.canReadNativePdf ? await options.loadUserPdf?.(part.artifactId) : null;
				parts.push(dataUrl
					? { type: "file", file: { filename: part.filename, file_data: dataUrl } }
					: { type: "text", text: `[PDF "${part.filename}" is attached but not sent to this model as a document; read it with attachment_read (id ${part.artifactId})]` });
				continue;
			}
			if (part.type !== "screenshot_ref") {
				parts.push(part);
				continue;
			}
			// L19: sem visão, screenshot não vai ao modelo; o texto aponta a alternativa.
			if (options?.canSeeScreenshots === false) {
				parts.push({
					type: "text",
					text: `[screenshot artifact:${part.artifactId} omitted: this model cannot see images; read the page as text instead]`,
				});
				continue;
			}
			const dataUrl = loadScreenshot
				? await loadScreenshot(part.artifactId)
				: null;
			if (dataUrl) {
				parts.push({ type: "image_url", image_url: { url: dataUrl } });
			} else {
				parts.push({
					type: "text",
					text: `[screenshot artifact:${part.artifactId}]`,
				});
			}
		}
		resolved.push({ ...message, content: parts });
	}
	return resolved;
}

function sanitizeBlockedTools(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const blocked: Record<string, string> = {};
	for (const [name, lastError] of Object.entries(value as Record<string, unknown>)) {
		if (typeof lastError !== "string") continue;
		const key = name.trim();
		if (!key || key.length > 120) continue;
		blocked[key] = lastError.slice(0, 300);
		if (Object.keys(blocked).length >= 20) break;
	}
	return Object.keys(blocked).length > 0 ? blocked : undefined;
}

function sanitizeToolCallHistory(
	value: unknown,
): AgentRunCheckpoint["toolCallHistory"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: NonNullable<AgentRunCheckpoint["toolCallHistory"]> = {};
	for (const [name, list] of Object.entries(value as Record<string, unknown>)) {
		if (!Array.isArray(list)) continue;
		const records = list
			.filter(
				(item): item is { argsHash: string; ok: boolean } =>
					!!item &&
					typeof item === "object" &&
					typeof (item as { argsHash?: unknown }).argsHash === "string" &&
					typeof (item as { ok?: unknown }).ok === "boolean",
			)
			.slice(-TOOL_CALL_HISTORY_SIZE);
		if (records.length > 0) out[name] = records;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeToolCapExtensions(
	value: unknown,
): Record<string, number> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, number> = {};
	for (const [name, cap] of Object.entries(value as Record<string, unknown>)) {
		if (typeof cap === "number" && Number.isFinite(cap) && cap > 0) {
			out[name] = Math.floor(cap);
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

const MAX_OBJECTIVE_REVISIONS = 20;

function parseObjectiveRevisions(raw: unknown): AgentRunCheckpoint["objectiveRevisions"] {
	if (!Array.isArray(raw)) return undefined;
	const out: NonNullable<AgentRunCheckpoint["objectiveRevisions"]> = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const entry = item as Record<string, unknown>;
		if (
			typeof entry.previousText !== "string" ||
			typeof entry.newText !== "string" ||
			typeof entry.reason !== "string" ||
			typeof entry.version !== "number" ||
			!Number.isInteger(entry.version) ||
			typeof entry.at !== "string"
		) continue;
		out.push({
			previousText: entry.previousText.slice(0, 2_000),
			newText: entry.newText.slice(0, 2_000),
			reason: entry.reason.slice(0, 200),
			version: entry.version,
			at: entry.at.slice(0, 40),
			...(typeof entry.atStep === "number" && Number.isFinite(entry.atStep) ? { atStep: Math.floor(entry.atStep) } : {}),
		});
	}
	return out.length ? out.slice(-MAX_OBJECTIVE_REVISIONS) : undefined;
}

const MAX_TRIAGED_BURSTS = 20;

function parseTriagedInputs(raw: unknown): AgentRunCheckpoint["triagedInputs"] {
	if (!Array.isArray(raw)) return undefined;
	const out: NonNullable<AgentRunCheckpoint["triagedInputs"]> = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const entry = item as Record<string, unknown>;
		const verdict = entry.verdict as Record<string, unknown> | null | undefined;
		if (
			!Array.isArray(entry.ids) ||
			typeof entry.text !== "string" ||
			!verdict ||
			(verdict.kind !== "chat" && verdict.kind !== "change" && verdict.kind !== "later") ||
			typeof verdict.cancel !== "boolean" ||
			typeof verdict.reply !== "string" ||
			typeof verdict.instruction !== "string"
		) continue;
		const ids = entry.ids.filter((id): id is string => typeof id === "string");
		if (ids.length === 0) continue;
		out.push({
			ids,
			text: entry.text.slice(0, 4_000),
			verdict: {
				kind: verdict.kind,
				cancel: verdict.cancel,
				reply: verdict.reply.slice(0, 500),
				instruction: verdict.instruction.slice(0, 600),
				...(verdict.wantsFile === true ? { wantsFile: true } : {}),
			},
		});
	}
	return out.length ? out.slice(-MAX_TRIAGED_BURSTS) : undefined;
}

export function buildRuntimeCheckpoint(input: {
	messages: AgentRunCheckpoint["messages"];
	conversation: LlmMessage[];
	userImageArtifactIds?: string[];
	generatedImageCount?: number;
	shownImageCount?: number;
	nextStepIndex: number;
	model: string;
	sandboxSessionId?: string | null;
	consumedInputIds?: string[];
	compact?: boolean;
	usageTotals?: AgentRunCheckpoint["usageTotals"];
	toolCallCounts?: Record<string, number>;
	toolCallHistory?: AgentRunCheckpoint["toolCallHistory"];
	toolCapExtensions?: Record<string, number>;
	extensionCount?: number;
	consecutiveToolFailures?: number;
	blockedTools?: Record<string, string>;
	effectiveHard?: number;
	progressCursor?: number;
	loginAsked?: string[];
	pendingLogin?: AgentRunCheckpoint["pendingLogin"];
	executionLedger?: AgentRunCheckpoint["executionLedger"];
	taskState?: AgentRunCheckpoint["taskState"];
	objectiveRevisions?: AgentRunCheckpoint["objectiveRevisions"];
	triagedInputs?: AgentRunCheckpoint["triagedInputs"];
	researchNotes?: AgentRunCheckpoint["researchNotes"];
	pendingFollowUps?: string[];
	capabilities?: AgentRunCheckpoint["capabilities"];
	modelTier?: AgentRunCheckpoint["modelTier"];
	modelEscalations?: AgentRunCheckpoint["modelEscalations"];
	activeElapsedMs?: number;
	loadedTools?: string[];
	toolCache?: AgentRunCheckpoint["toolCache"];
	transcriptWatermark?: AgentRunCheckpoint["transcriptWatermark"];
	carriedNotes?: AgentRunCheckpoint["carriedNotes"];
}): AgentRunCheckpoint {
	return {
		version: AGENT_RUNTIME_CHECKPOINT_VERSION,
		...(input.activeElapsedMs !== undefined ? { activeElapsedMs: Math.max(0, Math.round(input.activeElapsedMs)) } : {}),
		messages: input.messages,
		userImageArtifactIds: input.userImageArtifactIds,
		generatedImageCount: input.generatedImageCount,
		shownImageCount: input.shownImageCount,
		llmMessages: serializeLlmMessages(input.conversation),
		nextStepIndex: input.nextStepIndex,
		model: input.model,
		sandboxSessionId: input.sandboxSessionId ?? null,
		consumedInputIds: input.consumedInputIds ?? [],
		compact: input.compact ?? false,
		usageTotals: input.usageTotals,
		toolCallCounts: input.toolCallCounts,
		toolCallHistory: input.toolCallHistory,
		toolCapExtensions: input.toolCapExtensions,
		extensionCount: input.extensionCount,
		consecutiveToolFailures: input.consecutiveToolFailures,
		blockedTools: input.blockedTools,
		effectiveHard: input.effectiveHard,
		progressCursor: input.progressCursor,
		loginAsked: input.loginAsked,
		pendingLogin: input.pendingLogin,
		...(input.executionLedger ? { executionLedger: input.executionLedger } : {}),
		...(input.taskState ? { taskState: input.taskState } : {}),
		...(input.objectiveRevisions?.length ? { objectiveRevisions: input.objectiveRevisions } : {}),
		...(input.triagedInputs?.length ? { triagedInputs: input.triagedInputs } : {}),
		...(input.pendingFollowUps?.length ? { pendingFollowUps: input.pendingFollowUps } : {}),
		...(input.researchNotes?.length ? { researchNotes: input.researchNotes } : {}),
		...(input.capabilities ? { capabilities: input.capabilities } : {}),
		...(input.modelTier ? { modelTier: input.modelTier } : {}),
		...(input.modelEscalations?.length ? { modelEscalations: input.modelEscalations } : {}),
		...(input.loadedTools?.length ? { loadedTools: input.loadedTools.slice(0, 200) } : {}),
		...(input.toolCache ? { toolCache: input.toolCache } : {}),
		...(input.transcriptWatermark ? { transcriptWatermark: input.transcriptWatermark } : {}),
		...(input.carriedNotes?.length ? { carriedNotes: input.carriedNotes } : {}),
	};
}

export function parseRuntimeCheckpoint(
	raw: unknown,
): AgentRunCheckpoint | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as AgentRunCheckpoint;
	if (!Array.isArray(value.messages)) return null;
	return {
		version: value.version ?? 0,
		...(typeof value.activeElapsedMs === "number" && Number.isFinite(value.activeElapsedMs) && value.activeElapsedMs >= 0 ? { activeElapsedMs: value.activeElapsedMs } : {}),
		messages: value.messages,
		userFileArtifactIds: Array.isArray(value.userFileArtifactIds) ? value.userFileArtifactIds.filter((id): id is string => typeof id === "string").slice(0, 5) : undefined,
		userImageArtifactIds: Array.isArray(value.userImageArtifactIds) ? value.userImageArtifactIds.filter((id): id is string => typeof id === "string").slice(0, 4) : undefined,
		generatedImageCount: typeof value.generatedImageCount === "number" && Number.isInteger(value.generatedImageCount) && value.generatedImageCount >= 0 ? value.generatedImageCount : 0,
		shownImageCount: typeof value.shownImageCount === "number" && Number.isInteger(value.shownImageCount) && value.shownImageCount >= 0 ? value.shownImageCount : 0,
		llmMessages: Array.isArray(value.llmMessages)
			? value.llmMessages.map((message) => {
					if (!message || typeof message !== "object") return message;
					const { providerItems, ...rest } = message;
					return { ...rest, ...providerHistory(providerItems) };
				})
			: undefined,
		nextStepIndex:
			typeof value.nextStepIndex === "number" &&
			Number.isFinite(value.nextStepIndex)
				? Math.max(0, Math.floor(value.nextStepIndex))
				: 0,
		model: typeof value.model === "string" ? value.model : undefined,
		sandboxSessionId: value.sandboxSessionId ?? null,
		consumedInputIds: Array.isArray(value.consumedInputIds)
			? value.consumedInputIds.filter(
					(id): id is string => typeof id === "string",
				)
			: [],
		compact: value.compact === true,
		usageTotals:
			value.usageTotals &&
			typeof value.usageTotals.totalTokens === "number"
				? value.usageTotals
				: undefined,
		toolCallCounts:
			value.toolCallCounts && typeof value.toolCallCounts === "object"
				? value.toolCallCounts
				: undefined,
		toolCallHistory: sanitizeToolCallHistory(value.toolCallHistory),
		toolCapExtensions: sanitizeToolCapExtensions(value.toolCapExtensions),
		extensionCount:
			typeof value.extensionCount === "number"
				? Math.max(0, Math.floor(value.extensionCount))
				: undefined,
		consecutiveToolFailures:
			typeof value.consecutiveToolFailures === "number"
				? Math.max(0, Math.floor(value.consecutiveToolFailures))
				: undefined,
		blockedTools: sanitizeBlockedTools(value.blockedTools),
		effectiveHard:
			typeof value.effectiveHard === "number"
				? Math.max(1, Math.floor(value.effectiveHard))
				: undefined,
		progressCursor:
			typeof value.progressCursor === "number"
				? Math.max(0, Math.floor(value.progressCursor))
				: undefined,
		loginAsked: Array.isArray(value.loginAsked)
			? value.loginAsked.filter((key): key is string => typeof key === "string").slice(0, 50)
			: undefined,
		pendingLogin:
			value.pendingLogin &&
			typeof value.pendingLogin.loginId === "string" &&
			typeof value.pendingLogin.site === "string" &&
			typeof value.pendingLogin.url === "string"
				? {
						loginId: value.pendingLogin.loginId,
						site: value.pendingLogin.site,
						url: value.pendingLogin.url,
						...(value.pendingLogin.reason === "captcha" ? { reason: "captcha" as const } : {}),
						...(typeof value.pendingLogin.composioToolkit === "string" && /^[a-z0-9][a-z0-9_-]{0,59}$/.test(value.pendingLogin.composioToolkit) ? { composioToolkit: value.pendingLogin.composioToolkit } : {}),
						...(parseLoginConnector(value.pendingLogin.connector) ? { connector: parseLoginConnector(value.pendingLogin.connector)! } : {}),
						...(parseLoginVaultOffer(value.pendingLogin.vault) ? { vault: parseLoginVaultOffer(value.pendingLogin.vault)! } : {}),
						...(typeof value.pendingLogin.vaultTried === "string" && value.pendingLogin.vaultTried ? { vaultTried: value.pendingLogin.vaultTried.slice(0, 400) } : {}),
						...(value.pendingLogin.useVault === true ? { useVault: true } : {}),
						...(value.pendingLogin.codeField === true ? { codeField: true } : {}),
						...(typeof value.pendingLogin.codeEnc === "string" && value.pendingLogin.codeEnc.length < 2000 ? { codeEnc: value.pendingLogin.codeEnc } : {}),
					}
				: undefined,
		executionLedger: value.executionLedger
			? parseLedgerState(value.executionLedger)
			: undefined,
		taskState: parseTaskState(value.taskState),
		objectiveRevisions: parseObjectiveRevisions(value.objectiveRevisions),
		triagedInputs: parseTriagedInputs(value.triagedInputs),
		pendingFollowUps: parsePendingFollowUps(value.pendingFollowUps),
		researchNotes: parseResearchNotes(value.researchNotes).length ? parseResearchNotes(value.researchNotes) : undefined,
		capabilities: parseCapabilitySnapshot(value.capabilities),
		...(isModelTier(value.modelTier) ? { modelTier: value.modelTier } : {}),
		...(parseModelEscalations(value.modelEscalations).length ? { modelEscalations: parseModelEscalations(value.modelEscalations) } : {}),
		...(Array.isArray(value.loadedTools) ? { loadedTools: value.loadedTools.filter((name): name is string => typeof name === "string").slice(0, 200) } : {}),
		...(parseToolCacheState(value.toolCache) ? { toolCache: parseToolCacheState(value.toolCache)! } : {}),
		...(parseCarriedNotes(value.carriedNotes).length ? { carriedNotes: parseCarriedNotes(value.carriedNotes) } : {}),
		...(parseTranscriptWatermark(value.transcriptWatermark) ? { transcriptWatermark: parseTranscriptWatermark(value.transcriptWatermark)! } : {}),
		...(parseTranscriptSeed(value.transcriptSeed) ? { transcriptSeed: parseTranscriptSeed(value.transcriptSeed)! } : {}),
	};
}

function parseCarriedNotes(raw: unknown): NonNullable<AgentRunCheckpoint["carriedNotes"]> {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((note): note is { key: string; content: string; idleTurns: number } => !!note && typeof note.key === "string" && typeof note.content === "string" && typeof note.idleTurns === "number" && Number.isFinite(note.idleTurns))
		.map((note) => ({ key: note.key.slice(0, 64), content: note.content.slice(0, 4_000), idleTurns: Math.max(0, Math.floor(note.idleTurns)) }))
		.slice(0, 8);
}

function parseTranscriptWatermark(raw: unknown): AgentRunCheckpoint["transcriptWatermark"] {
	if (!raw || typeof raw !== "object") return undefined;
	const mark = raw as Record<string, unknown>;
	if (typeof mark.messageId !== "string" || typeof mark.createdAt !== "string" || typeof mark.count !== "number" || !Number.isFinite(mark.count)) return undefined;
	return { messageId: mark.messageId, createdAt: mark.createdAt, count: Math.max(0, Math.floor(mark.count)) };
}

function parseTranscriptSeed(raw: unknown): AgentRunCheckpoint["transcriptSeed"] {
	if (!raw || typeof raw !== "object") return undefined;
	const seed = raw as Record<string, unknown>;
	if (typeof seed.fromRunId !== "string" || (seed.toolName !== undefined && typeof seed.toolName !== "string") || typeof seed.resultContent !== "string" || typeof seed.shortContent !== "string") return undefined;
	const taskList = parseTaskList(seed.taskList);
	return { fromRunId: seed.fromRunId, ...(typeof seed.toolName === "string" ? { toolName: seed.toolName } : {}), resultContent: seed.resultContent, shortContent: seed.shortContent, ...(taskList ? { taskList } : {}) };
}

function isModelTier(value: unknown): value is ModelTier {
	return (MODEL_TIERS as readonly unknown[]).includes(value);
}

function parseModelEscalations(raw: unknown): NonNullable<AgentRunCheckpoint["modelEscalations"]> {
	if (!Array.isArray(raw)) return [];
	return raw
		.flatMap((item) => {
			if (!item || typeof item !== "object") return [];
			const { from, to, reason, step } = item as Record<string, unknown>;
			if (!isModelTier(from) || !isModelTier(to) || typeof reason !== "string" || typeof step !== "number") return [];
			return [{ from, to, reason: reason.slice(0, 60), step: Math.max(0, Math.floor(step)) }];
		})
		.slice(0, 3);
}

export function toolIdempotencyKey(input: {
	runId: string;
	decisionIndex: number;
	toolCallId: string;
	toolName: string;
}): string {
	return `${input.runId}:${input.decisionIndex}:${input.toolCallId}:${input.toolName}`;
}

export function completedToolCallIds(conversation: LlmMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const message of conversation) {
		if (message.role === "tool" && message.tool_call_id) {
			ids.add(message.tool_call_id);
		}
	}
	return ids;
}

const MAX_PENDING_FOLLOW_UPS = 10;

function parsePendingFollowUps(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out = raw
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.slice(0, 600));
	return out.length ? out.slice(-MAX_PENDING_FOLLOW_UPS) : undefined;
}
