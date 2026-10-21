"use client";

import { readProviderRunUsage } from "@/lib/provider-run-usage";
import { canUseLegacyChat } from "@/lib/provider-model-picker";
import type { OutgoingAttachment } from "@/hooks/use-file-attachments";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type {
	Message,
	QuestionnaireAnswersData,
	QuestionnaireStatus,
} from "@/components/ui/templates/template-4/data";
import {
	applySubagentEvent,
	mergeSubagentTasks,
	type SubagentTaskView,
	shouldCancelCreatedRun,
	insertCardAfterCurrentTurn,
	parseConversationCard,
	parseBotLinkCard,
	autoDecisionNote,
	parseBotAutoDecisionCard,
	parseBotNeedsUserCard,
	parseBotMessageContent,
	BOT_LINK_ROLE,
	SEND_TO_BOT_TOOL_NAME,
	type GroupStateResponse,
	type AgentPointerEvent,
	type ComputerUseEvent,
	type DevApprovalCardInfo,
	type PersistedConversationCard,
	type SessionMessage,
	type SkillListItemData,
	type RoutineListItemData,
	SUPERSEDED_CARD_DETAIL,
	decideRunFollow,
	decideStreamFailure,
	runFollowBackoffMs,
} from "@workspace/shared";
import type { AgentActivity } from "@/lib/working-status";
import { jevStatusText } from "@/lib/jev-status";
import { dedupeCards, reconcilePersistedThread } from "@/lib/thread-merge";
import { isMemoryUpdateResult, memoryChipId } from "@/lib/memory-chip";
import { isAwaitingBot, mergeNeedsUserMarkers } from "@/lib/bot-needs-thread";
import {
	setSkillProposalApplying,
	setSkillProposalError,
	setSkillProposalStatus,
	skillProposalMessageFromCard,
	skillProposalMessageFromEvent,
} from "@/lib/skill-proposal-message";
import { subscribeSkillProposalResolved } from "@/lib/skill-draft-handoff";
import { botProposalMessageFromEvent, setBotProposalState, type BotProposalChange } from "@/lib/bot-proposal-message";
import {
	mergeExternalMessages,
	mergeProposalStatuses,
	routineProposalMessageFromCard,
	setRoutineProposalState,
	type RoutineProposalChange,
} from "@/lib/routine-proposal-message";
import { subscribeAppResume } from "@/lib/resume-sync";
import { createThreadSync, type ThreadSync } from "@/lib/thread-sync";
import { createSendQueue } from "@/lib/send-queue";
import { inboundEmailBodyOf, inboundEmailThreadMessage } from "@/lib/email-message";
import { adoptLoadedThread, applyLiveEvent, createLiveBubbleState, hydrateRunEvents, mergePreservingSkills, trackSupersededBubbles, type LiveBubbleState } from "@/lib/thread-live";
import { eventRunStatus, isActiveRunStatus, isParkedRunStatus, isTerminalRunStatus, type HubEvent } from "@/lib/event-hub";
import { currentPollMode, getSharedEventHub, shouldPollTick } from "@/lib/event-hub-client";
import { messageReactions } from "@/lib/message-reactions";
import {
	clearStoredActiveRunId,
	clearStoredSseCursor,
	getStoredActiveRunId,
	setStoredActiveRunId,
	setStoredSseCursor,
} from "@/lib/active-run";
import { useDevSessionFixture } from "@/lib/dev-session/fixture";
import { stopConversationDevSessions } from "@/lib/dev-session/actions";
import { toolActivityDetail } from "@/lib/dev-session/live-line";
import { clearRunningImageGen, imageGenCardId, parseGenerateImageCall, replacePendingWithImages, settleImageGen } from "@/lib/image-gen";
import { parseRunCodeCallArgs, parseRunCodeResult } from "@/lib/code-run";
import { addLiveDevSessionCard, contextSummaryCard, insertContextDividers, insertDevSessionCards } from "@/lib/dev-session/cards";
import {
	hydrateDevSessionFromApi,
	hydrateDevSessionHistory,
	ingestContextCompacted,
	ingestContextUsage,
	ingestDevTiming,
	ingestDevSessionEvent,
	markRunEnded,
	markRunLive,
	recordSubagentEvent,
} from "@/lib/dev-session/store";
import { SESSION_SYNC_MS, syncConversationDevSessions } from "@/lib/dev-session/session-sync";
import {
	AtlasApiError,
	compactConversation,
	type CreateAgentRunResult,
	cancelAgentRun,
	getDevSessionDetail,
	getDevSessionEvents,
	listDevSessions,
	createAgentRun,
	createConversation,
	createRunInput,
	getAgentRun,
	getGroupState,
	getLatestCompletedRun,
	listActiveConversationRuns,
	postGroupMessage,
	listAgentRunEvents,
	listConversationMessagePage,
	pauseAgentRun,
	resumeAgentRun,
	streamAgentRun,
	streamChatCompletion,
	threadToChatMessages,
	type ComputerUseHandlers,
} from "@/lib/atlas-api";
import { isCardProtocolText } from "@/lib/card-decision";
import {
	resolveAgentModel,
	setStoredAgentModel,
} from "@/lib/openrouter-models";

function stampLocalTime(messages: Message[]): Message[] {
	if (messages.every((message) => message.createdAt)) return messages;
	const now = new Date().toISOString();
	return messages.map((message) => (message.createdAt ? message : { ...message, createdAt: now }));
}

function nextMessageId(): string {
	return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function conversationCardToMessage(
	id: string,
	card: PersistedConversationCard,
	agentName?: string,
): Message {
	if (card.kind === "confirm") {
		return {
			id,
			kind: "confirm",
			title: card.title,
			status: card.status,
			confirmId: card.confirmId,
			...(card.description ? { description: card.description } : {}),
			...(card.confirmLabel ? { confirmLabel: card.confirmLabel } : {}),
			...(card.cancelLabel ? { cancelLabel: card.cancelLabel } : {}),
			...(card.alwaysLabel ? { alwaysLabel: card.alwaysLabel } : {}),
			...(card.devApproval ? { devApproval: card.devApproval } : {}),
			...(card.secretsRequest ? { secretsRequest: card.secretsRequest } : {}),
			...(card.emailKeyRequest ? { emailKeyRequest: card.emailKeyRequest } : {}),
			...(card.githubIdentity ? { githubIdentity: card.githubIdentity } : {}),
			...(card.plan ? { plan: card.plan, ...(card.outcome?.detail ? { planOutcome: card.outcome.detail } : {}) } : {}),
			...(card.outcome?.detail === SUPERSEDED_CARD_DETAIL ? { superseded: true } : {}),
			...(card.status === "failed" && card.outcome?.detail ? { failureDetail: card.outcome.detail } : {}),
		};
	}
	if (card.kind === "routine-proposal") return routineProposalMessageFromCard(id, card);
	if (card.kind === "bot-proposal") {
		const { v: _v, kind: _kind, ...proposal } = card;
		return { id, kind: "bot-proposal", proposal };
	}
	if (card.kind === "images") return { id, kind: "images", source: card.origin, items: card.items };
	if (card.kind === "code-run") {
		return {
			id,
			kind: "code-run",
			callId: card.callId,
			code: card.code,
			status: card.status,
			...(card.durationMs !== undefined ? { durationMs: card.durationMs } : {}),
			...(card.output ? { output: card.output } : {}),
		};
	}
	if (card.kind === "task-list") return { id, kind: "task-list", runId: card.runId, items: card.items };
	if (card.kind === "compaction") return { id, kind: "compaction", before: card.before, after: card.after, summary: card.summary, ...(card.focus ? { focus: card.focus } : {}) };
	if (card.kind === "chart") return { id, kind: "chart", chartId: card.chartId, spec: card.spec, ...(card.filename ? { filename: card.filename } : {}) };
	if (card.kind === "file") {
		return {
			id,
			kind: "file",
			artifactId: card.artifactId,
			filename: card.filename,
			mime: card.mime,
			size: card.size,
			version: card.version,
			...(card.origin === "user" ? { origin: "user" as const } : {}),
		};
	}
	if (card.kind === "login") {
		return {
			id,
			kind: "login",
			loginId: card.loginId,
			site: card.site,
			url: card.url,
			status: card.status,
			...(card.runId ? { runId: card.runId } : {}),
			...(card.reason ? { reason: card.reason } : {}),
			...(card.composioToolkit ? { composioToolkit: card.composioToolkit } : {}),
			...(card.connector ? { connector: card.connector } : {}),
			...(card.vault ? { vault: card.vault } : {}),
			...(card.vaultTried ? { vaultTried: card.vaultTried } : {}),
			...(card.codeField ? { codeField: true } : {}),
		};
	}
	if (card.kind === "questionnaire") {
		return {
			id,
			kind: "questionnaire",
			questionnaireId: card.questionnaireId,
			title: card.title,
			status: card.status,
			...(card.description ? { description: card.description } : {}),
			items: card.items,
			...(card.answers ? { answers: card.answers } : {}),
		};
	}
	if (card.kind === "bot-profile") {
		return {
			id,
			kind: "bot-profile-confirm",
			proposal: {
				botId: card.botId,
				proposalId: card.proposalId,
				before: {
					name: card.before.name,
					snippet: card.before.snippet,
					description: card.before.description,
					openRouterModel: card.before.openRouterModel,
				},
				after: { ...card.after },
				fields: [...card.fields],
			},
			status: card.status,
		};
	}
	if (card.kind === "tool-budget") {
		return {
			id,
			kind: "tool-budget",
			tool: card.tool,
			from: card.from,
			to: card.to,
			...(card.connectorName ? { connectorName: card.connectorName } : {}),
		};
	}
	if (card.kind === "provider-fallback") {
		return { id, kind: "provider-fallback", text: card.message, from: card.from, to: card.to };
	}
	if (card.kind === "jev-status") {
		return {
			id: `jev-${card.runId}-${card.toolCallId}`,
			kind: "jev-status",
			text: jevStatusText(card, card.ok),
		};
	}
	if (card.kind === "subagents") {
		return {
			id,
			kind: "subagents",
			groupId: card.groupId,
			tasks: card.tasks.map((task) => ({ ...task })),
		};
	}
	if (card.kind === "routine") {
		return {
			id,
			kind: "routine",
			action: card.action,
			...(card.title ? { title: card.title } : {}),
			...(card.routineId ? { routineId: card.routineId } : {}),
			...(card.triggerType ? { triggerType: card.triggerType } : {}),
			...(card.detail ? { detail: card.detail } : {}),
			...(card.hookUrl ? { hookUrl: card.hookUrl } : {}),
			...(card.hookSecret ? { hookSecret: card.hookSecret } : {}),
			...(card.items ? { items: card.items } : {}),
		};
	}
	return {
		id,
		kind: "skill",
		action: card.action,
		...(card.title ? { title: card.title } : {}),
		...(card.capabilityKey ? { capabilityKey: card.capabilityKey } : {}),
		...(card.versionNumber !== undefined ? { versionNumber: card.versionNumber } : {}),
		...(card.detail ? { detail: card.detail } : {}),
		...(card.items ? { items: card.items } : {}),
		...(card.draftCount !== undefined ? { draftCount: card.draftCount } : {}),
		...(card.learned && card.skillId ? { learned: true, skillId: card.skillId, ...(card.undone ? { undone: true } : {}) } : {}),
		...(agentName || card.agentName ? { agentName: agentName ?? card.agentName } : {}),
	};
}

function botLinkMessageId(botMessageId: string): string {
	return `bot-link-${botMessageId}`;
}

/** `send_to_bot` entregue: o resultado traz o destino; o título vem dos argumentos da chamada. */
function botLinkFromToolResult(summary: string, args: string | undefined): Message | null {
	try {
		const result = JSON.parse(summary) as { delivered?: boolean; target?: string; targetId?: string; messageId?: string };
		if (!result.delivered || !result.target || !result.targetId || !result.messageId) return null;
		const title = args ? ((JSON.parse(args) as { title?: unknown }).title ?? "") : "";
		return {
			id: botLinkMessageId(result.messageId),
			kind: "bot-link",
			botId: result.targetId,
			botName: result.target,
			title: typeof title === "string" ? title : "",
			botMessageId: result.messageId,
		};
	} catch {
		return null;
	}
}

function sessionMessageToThread(message: SessionMessage): Message | null {
	const built = buildSessionMessage(message);
	if (!built) return null;
	// Reações vêm junto da lista; o balão as lê do estado compartilhado (otimista + hub).
	if (message.role === "user" || message.role === "assistant") messageReactions.seed(message.id, message.reactions);
	// Rotina, lembrete ou evento que produziu a fala: marcador acima do balão.
	if (built.kind === "assistant" && message.source) return { ...built, runSource: message.source, ...(message.runId ? { runId: message.runId } : {}), createdAt: message.createdAt };
	if (built.kind === "assistant" && message.runId) return { ...built, runId: message.runId, createdAt: message.createdAt };
	return { ...built, createdAt: message.createdAt };
}

function buildSessionMessage(message: SessionMessage): Message | null {
	// Conversa entre bots: marcador "Enviou mensagem para X" (id estável = o do live).
	if ((message.role as string) === BOT_LINK_ROLE) {
		// "X precisa de você": o id é o da linha (o marcador muda de estado no lugar).
		const needs = parseBotNeedsUserCard(message.content);
		if (needs) {
			return { id: message.id, kind: "needs-user", botId: needs.botId, botName: needs.botName, title: needs.title, botMessageId: needs.botMessageId, need: needs.need, status: needs.status };
		}
		const decided = parseBotAutoDecisionCard(message.content);
		if (decided) {
			return { id: message.id, kind: "auto-decision", botId: decided.botId, botName: decided.botName, decision: decided.decision, note: autoDecisionNote(decided), subject: decided.subject, reason: decided.reason, status: decided.status };
		}
		const card = parseBotLinkCard(message.content);
		return card
			? { id: botLinkMessageId(card.botMessageId), kind: "bot-link", botId: card.botId, botName: card.botName, title: card.title, botMessageId: card.botMessageId }
			: null;
	}
	if (message.role === "user" && message.origin === "bot") {
		const framed = parseBotMessageContent(message.content);
		return {
			id: message.id,
			kind: "user",
			text: framed?.text ?? message.content,
			bot: {
				kind: framed?.kind ?? "request",
				...(message.fromBotId ? { fromBotId: message.fromBotId } : {}),
				...(message.fromBotName ? { fromBotName: message.fromBotName } : {}),
				...(message.botMessageId ? { botMessageId: message.botMessageId } : {}),
			},
		};
	}
	if (message.role === "assistant" && message.origin === "bot") {
		return {
			id: message.id,
			kind: "assistant",
			text: message.content,
			bot: { kind: "answer", ...(message.botMessageId ? { botMessageId: message.botMessageId } : {}) },
		};
	}
	if (message.role === "user" && message.source?.kind === "email") {
		const card = inboundEmailThreadMessage(message.id, message.content);
		if (card) return card;
	}
	if (message.role === "user") {
		return { id: message.id, kind: "user", text: message.content };
	}
	if (message.role === "assistant") {
		// Conversa de grupo: a fala grava o membro que a escreveu.
		if (message.fromBotName) {
			return {
				id: message.id,
				kind: "assistant",
				text: message.content,
				author: { ...(message.fromBotId ? { id: message.fromBotId } : {}), name: message.fromBotName },
			};
		}
		return { id: message.id, kind: "assistant", text: message.content };
	}
	// Card `questionnaire` (role próprio, não vai ao LLM): parse via
	// parseConversationCard + narrow para o kind.
	if ((message.role as string) === "questionnaire") {
		const card = parseConversationCard(message.content);
		if (!card || card.kind !== "questionnaire") return null;
		return conversationCardToMessage(message.id, card);
	}
	// Card `bot-profile` (gate humano da proposta de perfil): mesmo padrão.
	if ((message.role as string) === "bot-profile") {
		const card = parseConversationCard(message.content);
		if (!card || card.kind !== "bot-profile") return null;
		return conversationCardToMessage(message.id, card);
	}
	// Card `skill-proposal` (gate humano do propose_skill/delete_skill): contrato do K1.
	if ((message.role as string) === "skill-proposal") {
		return skillProposalMessageFromCard(message.id, message.content);
	}
	if (
		message.role === "skill" ||
		message.role === "confirm" ||
		(message.role as string) === "login" ||
		(message.role as string) === "file" ||
		message.role === "routine" ||
		(message.role as string) === "tool-budget" ||
		(message.role as string) === "jev-status" ||
		(message.role as string) === "provider-fallback" ||
		(message.role as string) === "subagents"
		|| (message.role as string) === "routine-proposal"
		|| (message.role as string) === "bot-proposal"
		|| (message.role as string) === "images"
		|| (message.role as string) === "code-run"
		|| (message.role as string) === "chart"
		|| (message.role as string) === "task-list"
		|| (message.role as string) === "compaction"
	) {
		// Fallback: card questionnaire persistido sob outro role.
		if (message.content.includes('"questionnaire"')) {
			const compat = parseConversationCard(message.content);
			if (compat && compat.kind === "questionnaire") {
				return conversationCardToMessage(message.id, compat);
			}
		}
		const card = parseConversationCard(message.content);
		if (!card) return null;
		return conversationCardToMessage(message.id, card);
	}
	return {
		id: message.id,
		kind: "tool",
		label: message.role,
		text: message.content,
	};
}

type ThreadPage = {
	messages: Message[];
	oldest: { createdAt: string; id: string } | null;
	hasMore: boolean;
};

async function fetchThreadPage(
	conversationId: string,
	options?: { limit?: number; before?: { createdAt: string; id: string } },
): Promise<ThreadPage> {
	const { messages: rows, hasMore } = await listConversationMessagePage(conversationId, options);
	const dismissed = readDismissedIds(conversationId);
	const messages = rows
		.map(sessionMessageToThread)
		.filter((item): item is Message => item !== null)
		.filter((item) => {
			if (dismissed.has(item.id)) return false;
			if (item.kind === "confirm" && item.confirmId && dismissed.has(item.confirmId)) {
				return false;
			}
			if (
				item.kind === "questionnaire" &&
				item.questionnaireId &&
				dismissed.has(item.questionnaireId)
			) {
				return false;
			}
			return true;
		});
	return {
		messages,
		oldest: rows[0] ? { createdAt: rows[0].createdAt, id: rows[0].id } : null,
		hasMore,
	};
}

/** Cards dispensados pelo usuário (X): não ressuscitam no rebuild. Por conversa. */
function readDismissedIds(conversationId: string): Set<string> {
	try {
		const raw = localStorage.getItem(`atlas:dismissed:${conversationId}`);
		const arr = raw ? (JSON.parse(raw) as unknown) : [];
		if (Array.isArray(arr)) return new Set(arr.filter((v): v is string => typeof v === "string"));
	} catch {
		// storage indisponível: sem filtro
	}
	return new Set();
}

type SkillActivityAction =
	| "created"
	| "updated"
	| "deleted"
	| "shown"
	| "listed"
	| "cleaned";

const SKILL_ACTIONS: ReadonlySet<string> = new Set<string>([
	"created",
	"updated",
	"deleted",
	"shown",
	"listed",
	"cleaned",
]);

function isSkillAction(action: string): action is SkillActivityAction {
	return SKILL_ACTIONS.has(action);
}

function isSkillDecisionAction(action: string): boolean {
	return action === "deleted" || action === "cleaned";
}

function markPendingConfirms(
	messages: Message[],
	status: "approved" | "rejected",
): Message[] {
	return messages.map((item) =>
		item.kind === "confirm" && (item.status ?? "pending") === "pending"
			? { ...item, status }
			: item,
	);
}

async function loadRunEventPayloads(runId: string): Promise<{
	events: ComputerUseEvent[];
	lastSeq: number;
}> {
	const events: ComputerUseEvent[] = [];
	let after = 0;
	for (let page = 0; page < 20; page += 1) {
		const body = await listAgentRunEvents(runId, after);
		const batch = body.events ?? [];
		if (batch.length === 0) break;
		for (const record of batch) {
			if (
				record.payload &&
				typeof record.payload === "object" &&
				"type" in record.payload
			) {
				events.push(record.payload as ComputerUseEvent);
			}
			after = record.seq;
		}
		if (batch.length < 200) break;
	}
	return { events, lastSeq: after };
}

export function createComputerHandlers(params: {
	onAgentPointer?: (event: AgentPointerEvent) => void;
	onSandboxSession?: (session: {
		sessionId: string;
		viewerUrl: string;
	}) => void;
	onRunId?: (runId: string) => void;
	onDone?: () => void;
	/** Modelo que respondeu no run (opaco); a UI compara com o pedido. */
	onServedModel?: (model: string) => void;
	onUsage?: (usage: unknown) => void;
	onPaused?: () => void;
	onCancelled?: (reason?: string) => void;
	onStatus?: (status: string, detail?: string) => void;
	onActivity?: () => void;
	onAgentActivity?: (activity: AgentActivity) => void;
	onStreamingMessage?: (id: string | null) => void;
	onSkill?: (event: {
		action: string;
		skillId?: string;
		capabilityKey?: string;
		title?: string;
		versionNumber?: number;
		detail?: string;
		items?: SkillListItemData[];
		draftCount?: number;
		learned?: boolean;
	}) => void;
	onRoutine?: (event: {
		action: string;
		routineId?: string;
		title?: string;
		triggerType?: "cron" | "event" | "once" | "interval";
		detail?: string;
		hookUrl?: string;
		hookSecret?: string;
		items?: RoutineListItemData[];
	}) => void;
	onConfirm?: (event: {
		confirmId: string;
		title: string;
		description?: string;
		confirmLabel?: string;
		cancelLabel?: string;
		alwaysLabel?: string;
		devApproval?: DevApprovalCardInfo;
		secretsRequest?: import("@workspace/shared").SecretsRequestInfo;
		emailKeyRequest?: import("@workspace/shared").EmailKeyRequestInfo;
		githubIdentity?: import("@workspace/shared").GithubIdentityCardInfo;
		plan?: import("@workspace/shared").PlanInfo;
		status?: "pending" | "approved" | "rejected";
	}) => void;
	agentName?: string;
	runId?: string;
	/** Balões ao vivo já cobertos pelo servidor (compartilhado com a hidratação do run). */
	liveState?: LiveBubbleState;
	setMessages: Dispatch<SetStateAction<Message[]>>;
}): ComputerUseHandlers {
	const liveState = params.liveState ?? createLiveBubbleState();
	// Argumentos das chamadas em curso (o resultado de send_to_bot não repete o título).
	const toolArgs = new Map<string, string>();
	return {
		onRunId: params.onRunId,
  onProviderFallback: (event) => {
   const id = `provider-fallback-${params.runId ?? "local"}-${event.from}-${event.to}`;
   params.setMessages((previous) => previous.some((message) => message.id === id) ? previous : dedupeCards(insertCardAfterCurrentTurn(previous, { id, kind: "provider-fallback", text: event.message, from: event.from, to: event.to })));
  },
		onDelta: (id, delta) => {
			params.onActivity?.();
			params.onStreamingMessage?.(id);
			params.onAgentActivity?.({ phase: "writing" });
			params.setMessages((previous) =>
				applyLiveEvent(previous, { type: "assistant_delta", id, delta }, liveState),
			);
		},
		onDiscard: () => {
			params.onActivity?.();
			params.onStreamingMessage?.(null);
			params.onAgentActivity?.({ phase: "thinking" });
			params.setMessages((previous) =>
				applyLiveEvent(previous, { type: "assistant_discard" }, liveState),
			);
		},
		onSession: params.onSandboxSession,
		onAgentPointer: params.onAgentPointer,
		onToolCall: (call) => {
			toolArgs.set(call.id, call.args);
			if (call.name === "run_code") {
				const code = parseRunCodeCallArgs(call.args);
				if (code) {
					const card: Message = { id: `code-run-${call.id}`, kind: "code-run", callId: call.id, code, status: "running" };
					params.setMessages((previous) => previous.some((item) => item.id === card.id)
						? previous
						: dedupeCards(insertCardAfterCurrentTurn(previous, card)));
				}
			}
			if (call.name === "generate_image") {
				const { count, aspectRatio } = parseGenerateImageCall(call.args);
				const card: Message = { id: imageGenCardId(call.id), kind: "image-gen", callId: call.id, count, aspectRatio, startedAt: Date.now(), status: "running" };
				params.setMessages((previous) => previous.some((item) => item.id === card.id)
					? previous
					: dedupeCards(insertCardAfterCurrentTurn(previous, card)));
			}
			params.onActivity?.();
			params.onStreamingMessage?.(null);
			params.onAgentActivity?.({
				phase: "tool",
				tool: call.name,
				step: call.step,
				maxSteps: call.maxSteps,
				...(toolActivityDetail(call.name, call.args) ? { detail: toolActivityDetail(call.name, call.args)! } : {}),
			});
		},
		onToolResult: (result) => {
			params.onActivity?.();
			params.onStreamingMessage?.(null);
			params.onAgentActivity?.({ phase: "thinking" });
			if (result.name === "generate_image") {
				params.setMessages((previous) => settleImageGen(previous, result.id, result));
			}
			if (result.name === "run_code") {
				const outcome = parseRunCodeResult(result);
				const cardId = `code-run-${result.id}`;
				params.setMessages((previous) => previous.map((item) => item.id === cardId && item.kind === "code-run"
					? { ...item, status: outcome.ok ? "ok" : "error", output: outcome.output, ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}) }
					: item));
			}
			if (result.name === SEND_TO_BOT_TOOL_NAME && result.ok) {
				const link = botLinkFromToolResult(result.summary, toolArgs.get(result.id));
				if (link) {
					params.setMessages((previous) => previous.some((item) => item.id === link.id)
						? previous
						: dedupeCards(insertCardAfterCurrentTurn(previous, link)));
				}
			}
			if (isMemoryUpdateResult(result)) {
				const chip: Message = { id: memoryChipId(params.runId), kind: "memory-updated" };
				params.setMessages((previous) => previous.some((item) => item.id === chip.id)
					? previous
					: dedupeCards(insertCardAfterCurrentTurn(previous, chip)));
			}
			if (result.jev) {
				const marker: Message = {
					id: `jev-${params.runId ?? "local"}-${result.id}`,
					kind: "jev-status",
					text: jevStatusText(result.jev, result.ok),
				};
				params.setMessages((previous) => previous.some((item) => item.id === marker.id)
					? previous
					: dedupeCards(insertCardAfterCurrentTurn(previous, marker)));
			}
		},
		onPaused: () => {
			params.onStreamingMessage?.(null);
			params.onPaused?.();
		},
		onCancelled: (reason) => {
			params.setMessages((previous) => clearRunningImageGen(previous));
			params.onStreamingMessage?.(null);
			params.onCancelled?.(reason);
		},
		onStatus: params.onStatus,
		onError: (error) => {
			params.setMessages((previous) => clearRunningImageGen(previous));
			params.onStreamingMessage?.(null);
			params.onAgentActivity?.({ phase: "idle" });
			params.setMessages((previous) =>
				applyLiveEvent(previous, { type: "error", error }, liveState),
			);
			params.onStatus?.("failed", error);
			params.onDone?.();
		},
		onSkill: (event) => {
			params.onActivity?.();
			params.onSkill?.(event);
			if (event.action === "creating" || !isSkillAction(event.action)) return;
			const items = Array.isArray(event.items)
				? (event.items.filter(
						(item): item is SkillListItemData =>
							!!item && typeof item === "object" && typeof item.capabilityKey === "string" && typeof item.title === "string",
					).slice(0, 25) as SkillListItemData[])
				: undefined;
			const skillMessage: Message = {
				id: params.runId
					? `skill-${params.runId}-${event.action}`
					: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
				kind: "skill",
				action: event.action,
				...(event.title !== undefined ? { title: event.title } : {}),
				...(event.capabilityKey !== undefined
					? { capabilityKey: event.capabilityKey }
					: {}),
				...(event.versionNumber !== undefined
					? { versionNumber: event.versionNumber }
					: {}),
				...(event.detail !== undefined ? { detail: event.detail } : {}),
				...(items !== undefined ? { items } : {}),
				...(typeof event.draftCount === "number" ? { draftCount: event.draftCount } : {}),
				...(event.learned && event.skillId ? { learned: true, skillId: event.skillId } : {}),
				...(params.agentName ? { agentName: params.agentName } : {}),
			};
			params.setMessages((previous) => {
				if (previous.some((item) => item.id === skillMessage.id)) return previous;
				const base = isSkillDecisionAction(event.action)
					? markPendingConfirms(previous, "approved")
					: previous;
				return dedupeCards(insertCardAfterCurrentTurn(base, skillMessage));
			});
		},
		onSkillProposal: (event) => {
			params.onActivity?.();
			const card = skillProposalMessageFromEvent(event);
			params.setMessages((previous) =>
				previous.some((item) => item.kind === "skill-proposal" && item.proposal.proposalId === event.proposalId)
					? previous
					: dedupeCards(insertCardAfterCurrentTurn(previous, card)),
			);
		},
		onBotProposal: (event) => {
			params.onActivity?.();
			const card = botProposalMessageFromEvent(event);
			params.setMessages((previous) =>
				previous.some((item) => item.kind === "bot-proposal" && item.proposal.proposalId === event.proposalId)
					? previous
					: dedupeCards(insertCardAfterCurrentTurn(previous, card)),
			);
		},
		onRoutine: (event) => {
			params.onActivity?.();
			params.onRoutine?.(event);
			// Card só na criação — list/update/execução não entram na timeline.
			if (event.action !== "created") return;
			const items = Array.isArray(event.items)
				? event.items
						.filter(
							(item): item is RoutineListItemData =>
								!!item &&
								typeof item === "object" &&
								typeof item.id === "string" &&
								typeof item.name === "string" &&
								(item.triggerType === "cron" ||
								item.triggerType === "event" ||
								item.triggerType === "once" ||
								item.triggerType === "interval") &&
								typeof item.enabled === "boolean",
						)
						.slice(0, 25)
				: undefined;
			const routineMessage: Message = {
				id: params.runId
					? `routine-${params.runId}-${event.action}-${event.routineId ?? "list"}`
					: `routine-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
				kind: "routine",
				action: event.action,
				...(event.title !== undefined ? { title: event.title } : {}),
				...(event.routineId !== undefined ? { routineId: event.routineId } : {}),
				...(event.triggerType !== undefined
					? { triggerType: event.triggerType }
					: {}),
				...(event.detail !== undefined ? { detail: event.detail } : {}),
				...(event.hookUrl !== undefined ? { hookUrl: event.hookUrl } : {}),
				...(event.hookSecret !== undefined
					? { hookSecret: event.hookSecret }
					: {}),
				...(items !== undefined ? { items } : {}),
			};
			params.setMessages((previous) => {
				if (previous.some((item) => item.id === routineMessage.id)) {
					return previous;
				}
				return dedupeCards(
					insertCardAfterCurrentTurn(previous, routineMessage),
				);
			});
		},
		onImages: (event) => {
			params.onActivity?.();
			const imageMessage: Message = {
				id: `images-${params.runId ?? "local"}-${event.items.map((item) => item.artifactId).join("-")}`,
				kind: "images",
				source: event.origin,
				items: event.items,
			};
			params.setMessages((previous) => {
				if (previous.some((item) => item.id === imageMessage.id)) return previous;
				const replaced = event.origin === "assistant" ? replacePendingWithImages(previous, imageMessage) : previous;
				return replaced !== previous ? replaced : dedupeCards(insertCardAfterCurrentTurn(previous, imageMessage));
			});
		},
		onDevSession: (event, meta) => {
			params.onActivity?.();
			ingestDevSessionEvent(event, { ...meta, runId: meta.runId ?? params.runId });
			if (event.type !== "dev_session_status") return;
			params.setMessages((previous) => addLiveDevSessionCard(previous, event.sessionId));
		},
		onDevTiming: (event, meta) => {
			ingestDevTiming(event, { ...meta, runId: meta.runId ?? params.runId });
		},
		onContextUsage: (event, meta) => {
			ingestContextUsage(event, { ...meta, runId: meta.runId ?? params.runId });
		},
		onContextCompacted: (event, meta) => {
			const runId = meta.runId ?? params.runId;
			ingestContextCompacted(event, { ...meta, runId });
			const card = contextSummaryCard(`${runId ?? "local"}:${meta.seq ?? Date.now()}`, event.before, event.after);
			params.setMessages((previous) =>
				previous.some((item) => item.id === card.id) ? previous : dedupeCards(insertCardAfterCurrentTurn(previous, card)),
			);
		},
		onSubagent: (event) => {
			params.onActivity?.();
			recordSubagentEvent(event);
			params.setMessages((previous) => {
				const index = previous.findIndex(
					(item) => item.kind === "subagents" && item.groupId === event.groupId,
				);
				const current = index >= 0 ? previous[index] : undefined;
				const tasks = applySubagentEvent(
					current?.kind === "subagents" ? current.tasks : [],
					event,
				);
				const block: Message = {
					id: current?.id ?? "subagents-" + event.groupId,
					kind: "subagents",
					groupId: event.groupId,
					tasks,
				};
				if (index >= 0) return previous.map((item, i) => (i === index ? block : item));
				return dedupeCards(insertCardAfterCurrentTurn(previous, block));
			});
		},
		onToolBudgetExtended: (event) => {
			params.onActivity?.();
			const budgetMessage: Message = {
				id: params.runId
					? `tool-budget-${params.runId}-${event.tool}-${event.to}`
					: `tool-budget-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
				kind: "tool-budget",
				tool: event.tool,
				from: event.from,
				to: event.to,
				...(event.connectorName !== undefined
					? { connectorName: event.connectorName }
					: {}),
			};
			params.setMessages((previous) =>
				previous.some((item) => item.id === budgetMessage.id)
					? previous
					: dedupeCards(insertCardAfterCurrentTurn(previous, budgetMessage)),
			);
		},
		onConfirm: (event) => {
			params.onActivity?.();
			params.onConfirm?.(event);
			const confirmMessage: Message = {
				id: event.confirmId || `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
				kind: "confirm",
				title: event.title,
				...(event.description !== undefined ? { description: event.description } : {}),
				// Resumo já decidido (ex.: autonomia atualizada) chega aprovado, sem botões.
				status: event.status ?? "pending",
				...(event.confirmLabel !== undefined ? { confirmLabel: event.confirmLabel } : {}),
				...(event.cancelLabel !== undefined ? { cancelLabel: event.cancelLabel } : {}),
				...(event.alwaysLabel !== undefined ? { alwaysLabel: event.alwaysLabel } : {}),
				...(event.devApproval ? { devApproval: event.devApproval } : {}),
				...(event.secretsRequest ? { secretsRequest: event.secretsRequest } : {}),
				...(event.emailKeyRequest ? { emailKeyRequest: event.emailKeyRequest } : {}),
				...(event.githubIdentity ? { githubIdentity: event.githubIdentity } : {}),
				...(event.plan ? { plan: event.plan } : {}),
				confirmId: event.confirmId,
			};
			params.setMessages((previous) => {
				if (previous.some(
					(m) =>
						m.id === confirmMessage.id ||
						(m.kind === "confirm" && m.confirmId === confirmMessage.confirmId),
				)) {
					return previous;
				}
				return dedupeCards(insertCardAfterCurrentTurn(previous, confirmMessage));
			});
		},
		onTaskList: (event) => {
			params.onActivity?.();
			const cardId = `task-list-${event.runId ?? "local"}`;
			params.setMessages((previous) => {
				// A lista mais recente do run substitui o cartão no lugar (nunca empilha); lista vazia remove.
				const index = previous.findIndex((m) => m.kind === "task-list" && (m.id === cardId || (event.runId !== undefined && m.runId === event.runId)));
				if (event.items.length === 0) return index < 0 ? previous : previous.filter((_, i) => i !== index);
				if (index >= 0) {
					const current = previous[index]!;
					return previous.map((m, i) => (i === index ? { id: current.id, kind: "task-list" as const, runId: event.runId ?? "local", items: event.items } : m));
				}
				return dedupeCards(insertCardAfterCurrentTurn(previous, { id: cardId, kind: "task-list", runId: event.runId ?? "local", items: event.items }));
			});
		},
		onChart: (event) => {
			params.onActivity?.();
			params.setMessages((previous) => {
				if (previous.some((m) => m.kind === "chart" && m.chartId === event.chartId)) return previous;
				const chartMessage: Message = {
					id: `chart-${event.chartId}`,
					kind: "chart",
					chartId: event.chartId,
					spec: event.spec,
					...(event.filename ? { filename: event.filename } : {}),
				};
				return dedupeCards(insertCardAfterCurrentTurn(previous, chartMessage));
			});
		},
		onFile: (event) => {
			params.onActivity?.();
			params.setMessages((previous) => {
				if (previous.some((m) => m.kind === "file" && m.artifactId === event.artifactId)) return previous;
				const fileMessage: Message = {
					id: `file-${event.artifactId}`,
					kind: "file",
					artifactId: event.artifactId,
					filename: event.filename,
					mime: event.mime,
					size: event.size,
					version: event.version,
				};
				return dedupeCards(insertCardAfterCurrentTurn(previous, fileMessage));
			});
		},
		onLogin: (event) => {
			params.onActivity?.();
			params.setMessages((previous) => {
				if (previous.some((m) => m.kind === "login" && m.loginId === event.loginId)) {
					return previous.map((m) =>
						m.kind === "login" && m.loginId === event.loginId
							? { ...m, status: event.status ?? "pending" }
							: m,
					);
				}
				const loginMessage: Message = {
					id: event.loginId,
					kind: "login",
					loginId: event.loginId,
					site: event.site,
					url: event.url,
					status: event.status ?? "pending",
					...(event.runId ? { runId: event.runId } : {}),
					...(event.reason ? { reason: event.reason } : {}),
					...(event.composioToolkit ? { composioToolkit: event.composioToolkit } : {}),
					...(event.connector ? { connector: event.connector } : {}),
					...(event.vault ? { vault: event.vault } : {}),
					...(event.vaultTried ? { vaultTried: event.vaultTried } : {}),
					...(event.codeField ? { codeField: true } : {}),
				};
				return dedupeCards(insertCardAfterCurrentTurn(previous, loginMessage));
			});
		},
		onDone: (result) => {
			params.setMessages((previous) => clearRunningImageGen(previous));
			if (result?.model) params.onServedModel?.(result.model);
			if (result?.usage) params.onUsage?.(result.usage);
			params.onStreamingMessage?.(null);
			params.onDone?.();
		},
	};
}

/** Sessões de desenvolvimento da conversa: hidrata o painel e devolve a conversa com os cartões. */
async function withDevSessionCards(conversationId: string, thread: Message[]): Promise<Message[]> {
	try {
		const sessions = await listDevSessions(conversationId);
		if (sessions.length === 0) return thread;
		const recent = [...sessions].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, 5);
		const [details, histories] = await Promise.all([
			Promise.all(recent.map((session) => getDevSessionDetail(session.id).catch(() => null))),
			Promise.all(recent.map((session) => getDevSessionEvents(session.id).catch(() => null))),
		]);
		recent.forEach((session, index) => {
			const detail = details[index];
			const history = histories[index];
			// Comandos, diffs e tarefas persistidos primeiro; o resumo da API (status atual) por cima.
			if (history) hydrateDevSessionHistory(history.events);
			hydrateDevSessionFromApi(
				{
					id: session.id,
					status: session.status,
					tier: session.tier,
					repo: session.repo,
					branch: session.branch,
					startedAt: session.startedAt,
					lastActiveAt: session.lastActiveAt,
					...(detail ? { todos: detail.todos, stats: detail.stats, pr: detail.pr } : {}),
				},
				{ authoritativeStatus: true },
			);
		});
		const compactions = histories.flatMap((history) => (history?.events ?? []).filter((event) => event.type === "context_compacted"));
		return insertContextDividers(insertDevSessionCards(thread, recent), compactions);
	} catch {
		return thread;
	}
}


async function resolveActiveRunId(conversationId: string): Promise<string | null> {
	const stored = getStoredActiveRunId(conversationId);
	try {
		const { runs } = await listActiveConversationRuns(conversationId);
		if (runs.length > 1) {
			console.warn(`multiplos runs ativos (${runs.length}), usando o mais recente`);
		}
		// Prefere o armazenado se ainda estiver ativo — evita pular para run errado.
		const storedActive = stored ? runs.find((r) => r.id === stored) : undefined;
		const active = storedActive ?? runs[0];
		if (active?.id) {
			setStoredActiveRunId(conversationId, active.id);
			return active.id;
		}
	} catch (error) {
		console.error("list active runs failed", error);
	}

	if (!stored) return null;

	try {
		const { run } = await getAgentRun(stored);
		if (
			run.status === "queued" ||
			run.status === "running" ||
			run.status === "waiting_user" ||
			run.status === "waiting_external" ||
			run.status === "paused" ||
			run.status === "retrying"
		) {
			return stored;
		}
		clearStoredActiveRunId(conversationId);
		return null;
	} catch {
		clearStoredActiveRunId(conversationId);
		return null;
	}
}

/** Mensagem do 409 da API quando a conversa foi ocupada por outro run no instante do envio (nada foi gravado). */
const ACTIVE_RUN_CONFLICT_PREFIX = "A conversa já tem uma tarefa em andamento";

/** Reenvia o pedido (mesmo conteúdo) quando a API recusou por corrida com o fim do run anterior. */
async function withActiveRunConflictRetry<T>(send: () => Promise<T>, signal: AbortSignal): Promise<T> {
	const delays = [400, 1_000, 2_000];
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await send();
		} catch (error) {
			const conflict = error instanceof AtlasApiError && error.status === 409 && error.message.startsWith(ACTIVE_RUN_CONFLICT_PREFIX);
			const delay = delays[attempt];
			if (!conflict || delay === undefined || signal.aborted) throw error;
			await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
		}
	}
}

/** Intervalo da conferência de um run estacionado (sem stream) contra o servidor. */
const PARKED_RUN_CHECK_MS = 5_000;

const LIVE_RUN_STATUSES = new Set([
	"queued",
	"running",
	"waiting_user",
	"waiting_external",
	"paused",
	"retrying",
]);

function isAbortLikeError(error: unknown): boolean {
	if (!error) return false;
	if (error instanceof DOMException && error.name === "AbortError") return true;
	if (error instanceof Error) {
		const name = error.name;
		const message = error.message.toLowerCase();
		if (name === "AbortError") return true;
		if (message.includes("aborted")) return true;
		if (message.includes("error in input stream")) return true;
		if (message.includes("bodystreambuffer")) return true;
	}
	return false;
}

/** Status após os quais o run nunca mais produz evento: mandar input é enterrar msg. */
const TERMINAL_RUN_STATUSES = new Set([
	"completed",
	"failed",
	"cancelled",
	"budget_exhausted",
]);

const GROUP_STATE_POLL_MS = 1500;
const PROACTIVE_WATCH_MS = 20_000;

export function useAtlasChat({
	agentId,
	groupId,
	conversationId,
	agentModel,
	sandboxSessionId,
	onSandboxSession,
	onRoutine,
	onAgentPointer,
	watchExternal = false,
}: {
	agentId: string;
	/** Bot principal com o modo proativo: traz para a thread o que o bot escreveu sozinho (lembrete, sugestão). */
	watchExternal?: boolean;
	/** Preenchido quando a conversa é de um grupo: as falas vão por /v1/groups e o servidor escolhe quem responde. */
	groupId?: string;
	conversationId?: string;
	agentModel?: string;
	sandboxSessionId?: string | null;
	onSandboxSession?: (session: {
		sessionId: string;
		viewerUrl: string;
	}) => void;
	/** SSE `routine` (agente criou/editou/listou uma rotina) — o caller pode recarregar a lista. */
	onRoutine?: (event: {
		action: string;
		routineId?: string;
		title?: string;
		triggerType?: "cron" | "event" | "once" | "interval";
		detail?: string;
		hookUrl?: string;
		hookSecret?: string;
		items?: RoutineListItemData[];
	}) => void;
	/** Cursor do agente no navegador do sandbox. */
	onAgentPointer?: (event: AgentPointerEvent) => void;
}) {
	const [messages, setMessagesRaw] = useState<Message[]>([]);
	// Toda mensagem nova sem horário recebe o horário local; o do servidor o substitui ao hidratar.
	const setMessages = useCallback<Dispatch<SetStateAction<Message[]>>>((update) => {
		setMessagesRaw((previous) => {
			const next = typeof update === "function" ? update(previous) : update;
			return stampLocalTime(next);
		});
	}, []);
	const [sending, setSending] = useState(false);
	const [loading, setLoading] = useState(false);
	const [hasMoreHistory, setHasMoreHistory] = useState(false);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const oldestCursorRef = useRef<{ createdAt: string; id: string } | null>(null);
	const loadingOlderRef = useRef(false);
	const [error, setError] = useState<string | null>(null);
	/** `/compact` em andamento ou o aviso curto de que nada foi feito (passageiro; o cartão final vai para a thread). */
	const [compactState, setCompactState] = useState<{ status: "working" } | { status: "notice"; text: string } | null>(null);
	const compactingRef = useRef(false);
	const [activeRunId, setActiveRunId] = useState<string | null>(null);
	/** Grupo: membro dono do run em andamento (autor do balão ao vivo). */
	const [liveBotId, setLiveBotId] = useState<string | null>(null);
	/** Grupo: quem está roteando/respondendo/na fila, segundo o servidor. */
	const [groupState, setGroupState] = useState<GroupStateResponse | null>(null);
	const [runStatus, setRunStatus] = useState<string | null>(null);
	// Sessões de código só "trabalham" enquanto há run do agente ativo (run pausado não conta).
	const liveDevRunId = activeRunId && runStatus !== "paused" ? activeRunId : null;
	useEffect(() => {
		if (!liveDevRunId) return;
		markRunLive(liveDevRunId);
		return () => markRunEnded(liveDevRunId);
	}, [liveDevRunId]);
	/** Modelo servido no último run concluído (A7); limpo ao enviar/trocar modelo. */
	const [servedModel, setServedModel] = useState<string | null>(null);
	const [runUsage, setRunUsage] = useState<ReturnType<typeof readProviderRunUsage>>(null);
	const receiveRunUsage = useCallback((raw: unknown) => setRunUsage(readProviderRunUsage(raw)), []);
	const [activity, setActivity] = useState<AgentActivity>({ phase: "idle" });
	const [streamingMessageId, setStreamingMessageId] = useState<string | null>(
		null,
	);
	const [model, setModelState] = useState(() =>
		resolveAgentModel(agentId, agentModel),
	);
	const conversationIdRef = useRef<string | null>(conversationId ?? null);
	const reconnectAbortRef = useRef<AbortController | null>(null);
	const sendAbortRef = useRef<AbortController | null>(null);
	const activeRunIdRef = useRef<string | null>(null);
	const sendingRef = useRef(false);
	/** Falhas seguidas do stream de follow; `notBefore` segura o poll (backoff). */
	const followBackoffRef = useRef({ failures: 0, notBefore: 0 });
	const transcriptEpochRef = useRef(0);
	/** Sincronização com o servidor da conversa aberta (null sem conversa). */
	const threadSyncRef = useRef<ThreadSync | null>(null);
	/** Passos ao vivo que o servidor já cobriu (por conversa aberta): os deltas que ainda chegarem para eles são ignorados. */
	const liveStateRef = useRef<LiveBubbleState>(createLiveBubbleState());
	/** Envios feitos enquanto o anterior ainda cria o run: entram como input assim que o run existe. */
	const sendQueueRef = useRef(createSendQueue<{ text: string; outgoing: OutgoingAttachment[]; options: { confirmId?: string } }>());
	const sendMessageRef = useRef<((text: string, outgoing?: OutgoingAttachment[], options?: { confirmId?: string }) => Promise<void>) | null>(null);
	const flushQueuedSends = useCallback(() => {
		void sendQueueRef.current.flush((item) => sendMessageRef.current?.(item.text, item.outgoing, item.options) ?? Promise.resolve());
	}, []);
	/** Tenta anexar ao run ativo da conversa aberta (chamado pelo hub e pela consulta de segurança). */
	const tryAttachRef = useRef<(() => void) | null>(null);
	const onSandboxSessionRef = useRef(onSandboxSession);
	onSandboxSessionRef.current = onSandboxSession;
	const onRoutineRef = useRef(onRoutine);
	onRoutineRef.current = onRoutine;
	const onAgentPointerRef = useRef(onAgentPointer);
	onAgentPointerRef.current = onAgentPointer;

	// Solta o run atual em todo terminal (done/cancel/falha observada ou não).
	// Sem isso, o composer continua enterrando steer num run morto.
	const clearRunRefs = useCallback((runId: string) => {
		const cid = conversationIdRef.current;
		if (cid) clearStoredActiveRunId(cid);
		clearStoredSseCursor(runId);
		if (activeRunIdRef.current === runId) {
			activeRunIdRef.current = null;
			setActiveRunId(null);
			setLiveBotId(null);
		}
		setRunStatus(null);
		setActivity({ phase: "idle" });
		setStreamingMessageId(null);
	}, []);

	// Modelo do bot: sincroniza sem remountar histórico/stream.
	useEffect(() => {
		setModelState(resolveAgentModel(agentId, agentModel));
	}, [agentId, agentModel]);

	const loadConversationThread = useCallback(async (convId: string): Promise<Message[]> => {
		const page = await fetchThreadPage(convId, { limit: 50 });
		if (conversationIdRef.current === convId && !oldestCursorRef.current) {
			oldestCursorRef.current = page.oldest;
			setHasMoreHistory(page.hasMore);
		}
		return page.messages;
	}, []);

	const loadOlderMessages = useCallback(async () => {
		const convId = conversationIdRef.current;
		const cursor = oldestCursorRef.current;
		if (!convId || !cursor || loadingOlderRef.current) return;
		loadingOlderRef.current = true;
		setLoadingOlder(true);
		try {
			const page = await fetchThreadPage(convId, { limit: 100, before: cursor });
			if (conversationIdRef.current !== convId) return;
			oldestCursorRef.current = page.oldest ?? cursor;
			setHasMoreHistory(page.hasMore);
			setMessages((previous) => {
				if (conversationIdRef.current !== convId) return previous;
				return dedupeCards([...page.messages, ...previous]);
			});
		} catch (error) {
			console.warn("load older messages failed", error);
		} finally {
			loadingOlderRef.current = false;
			if (conversationIdRef.current === convId) setLoadingOlder(false);
		}
	}, []);

	// Ao trocar de bot (ou conversa), carrega histórico e reconecta run ativo.
	// Rotina: não grava o prompt como mensagem do usuário; o resultado do agente
	// entra no chat normalmente (follow + ConversationMessage assistant).
	useEffect(() => {
		conversationIdRef.current = conversationId ?? null;
		setError(null);
		setRunUsage(null);
		sendAbortRef.current?.abort();
		sendAbortRef.current = null;
		reconnectAbortRef.current?.abort();
		reconnectAbortRef.current = null;

		sendingRef.current = false;
		followBackoffRef.current = { failures: 0, notBefore: 0 };
		setSending(false);
		setActiveRunId(null);
		setLiveBotId(null);
		setGroupState(null);
		activeRunIdRef.current = null;
		setRunStatus(null);
		setActivity({ phase: "idle" });
		setStreamingMessageId(null);
		setMessages([]);
		oldestCursorRef.current = null;
		setHasMoreHistory(false);
		setLoadingOlder(false);

		if (!conversationId) {
			setLoading(false);
			return;
		}

		let cancelled = false;
		const abort = new AbortController();
		reconnectAbortRef.current = abort;
		const epoch = transcriptEpochRef.current;
		setLoading(true);
		liveStateRef.current = createLiveBubbleState();
		sendQueueRef.current.clear();
		const threadSync = createThreadSync({
			fetchTail: async (limit) => (await fetchThreadPage(conversationId, { limit })).messages,
			apply: (update) => setMessages((previous) => (conversationIdRef.current === conversationId ? trackSupersededBubbles(previous, update(previous), liveStateRef.current) : previous)),
			isCurrent: () => !cancelled && !abort.signal.aborted && conversationIdRef.current === conversationId,
		});
		threadSyncRef.current = threadSync;

		const applyThread = async (): Promise<Message[]> => {
			const thread = await loadConversationThread(conversationId);
			const last = thread[thread.length - 1];
			if (!last || last.kind === "user") {
				try {
					const { run } = await getLatestCompletedRun(conversationId);
					const text = run?.resultText?.trim();
					const pendingObjective =
						last?.kind === "user" ? last.text.trim() : "";
					// Run de e-mail: o objetivo é o texto emoldurado; a thread mostra só o corpo da resposta.
					const objectiveRaw = run?.objective?.trim() ?? "";
					const runObjective = last?.kind === "user" && last.email ? (inboundEmailBodyOf(objectiveRaw) ?? objectiveRaw) : objectiveRaw;
					if (
						text &&
						pendingObjective &&
						runObjective &&
						runObjective === pendingObjective
					) {
						const already = thread.some(
							(item) =>
								item.kind === "assistant" && item.text.trim() === text,
						);
						if (!already) {
							thread.push({
								id: `run-result-${run!.id}`,
								kind: "assistant",
								text,
							});
						}
					}
				} catch {
					// ignore recovery errors
				}
			}
			return withDevSessionCards(conversationId, thread);
		};

		const followRun = async (runId: string) => {
			if (cancelled || abort.signal.aborted) return;
			if (sendingRef.current && activeRunIdRef.current === runId) return;
			if (sendingRef.current && activeRunIdRef.current) return;

			sendingRef.current = true;
			activeRunIdRef.current = runId;
			setActiveRunId(runId);
			markRunLive(runId);
			setStoredActiveRunId(conversationId, runId);
			setSending(true);
			setActivity({ phase: "thinking" });
			setRunStatus("running");

			const liveState = liveStateRef.current;
			let released = false;
			let doneSeen = false;
			// Run `paused` (login/captcha): fica "estacionado" com o id guardado para
			// o "Terminei" retomar ESTE run. Sem stream, sem "trabalhando", e o poll
			// não o reanexa (activeRunIdRef segue preenchido).
			let parked = false;
			const parkPaused = () => {
				parked = true;
				followBackoffRef.current = { failures: 0, notBefore: 0 };
				setRunStatus("paused");
				setActivity({ phase: "idle" });
				setStreamingMessageId(null);
				sendingRef.current = false;
				setSending(false);
			};
			const releaseFollow = () => {
				if (released) return;
				released = true;
				if (activeRunIdRef.current === runId) {
					activeRunIdRef.current = null;
					setActiveRunId(null);
					setLiveBotId(null);
				}
				setRunStatus(null);
				setActivity({ phase: "idle" });
				sendingRef.current = false;
				setSending(false);
				setStreamingMessageId(null);
			};

			try {
				let thread = await applyThread();
				const snapshot = await getAgentRun(runId).catch(() => null);
				if (snapshot?.run.usageJson && !abort.signal.aborted && !cancelled) receiveRunUsage(snapshot.run.usageJson);
				if (!cancelled && !abort.signal.aborted) setLiveBotId(snapshot?.run.botId ?? null);
				const live =
					snapshot !== null && LIVE_RUN_STATUSES.has(snapshot.run.status);
				if (live) {
					try {
						const { events, lastSeq } = await loadRunEventPayloads(runId);
						thread = hydrateRunEvents(thread, events, liveState);
						if (lastSeq > 0) setStoredSseCursor(runId, lastSeq);
					} catch (error) {
						console.warn("hydrate run events failed", error);
					}
				}
				if (!cancelled && !abort.signal.aborted) {
					// Fala enviada enquanto o fim da conversa era carregado ainda não está nessa foto: não some da tela.
					const loaded = thread;
					setMessages((previous) => adoptLoadedThread(loaded, previous));
				}
				if (!live || cancelled || abort.signal.aborted) {
					if (activeRunIdRef.current === runId) {
						clearStoredActiveRunId(conversationId);
						clearStoredSseCursor(runId);
						releaseFollow();
					}
					// O run pode ter terminado depois de `applyThread` e antes do snapshot: o fim carregado acima
					// seria velho e nada mais buscaria a resposta final. Busca de novo, insistindo até ela aparecer.
					if (!cancelled && !abort.signal.aborted) {
						await threadSync.sync({ runLive: false, resultText: snapshot?.run.resultText, retries: snapshot ? 3 : 0 });
					}
					return;
				}
				if (decideRunFollow(snapshot?.run.status) === "wait_user") {
					parkPaused();
					return;
				}

				const handlers = createComputerHandlers({
					runId,
					liveState,
					onSandboxSession: (session) => {
						onSandboxSessionRef.current?.(session);
					},
					onRoutine: (event) => onRoutineRef.current?.(event),
					onAgentPointer: (event) => onAgentPointerRef.current?.(event),
					onRunId: (id) => {
						setActiveRunId(id);
						activeRunIdRef.current = id;
						setStoredActiveRunId(conversationId, id);
					},
					onPaused: () => setRunStatus("paused"),
					onServedModel: setServedModel,
					onUsage: receiveRunUsage,
					onCancelled: () => {
						clearRunRefs(runId);
						setError("A execução foi cancelada.");
					},
					onStreamingMessage: setStreamingMessageId,
					onStatus: (status, detail) => {
						setRunStatus(status);
						if (status === "stale" || status === "retrying") {
							setError(
								detail ??
									"O worker parou. Confira Redis e se `pnpm --filter worker dev` está no ar.",
							);
						}
					},
					onActivity: () => setError(null),
					onAgentActivity: setActivity,
					onDone: () => {
						doneSeen = true;
						clearStoredActiveRunId(conversationId);
						clearStoredSseCursor(runId);
						// Libera o composer aqui: o cleanup pós-stream não roda se
						// activeRunId já foi anulado (sending ficava true).
						releaseFollow();
					},
					setMessages,
				});

				try {
					await streamAgentRun(runId, handlers, { signal: abort.signal });
				} catch (streamErr) {
					if (cancelled || abort.signal.aborted || isAbortLikeError(streamErr)) {
						return;
					}
					const ended = await getAgentRun(runId).catch(() => null);
					if (ended?.run.usageJson && !abort.signal.aborted && !cancelled) receiveRunUsage(ended.run.usageJson);
					const failures = followBackoffRef.current.failures + 1;
					const decision = decideStreamFailure({
						runStatus: ended?.run.status,
						aborted: false,
						httpStatus:
							streamErr instanceof AtlasApiError ? streamErr.status : undefined,
						failures,
					});
					if (ended && TERMINAL_RUN_STATUSES.has(ended.run.status)) {
						// continua no refresh abaixo
					} else if (decision.action === "wait_user") {
						parkPaused();
						return;
					} else {
						console.warn("reconnect stream ended", streamErr);
						const delayMs =
							decision.action === "retry" ? decision.delayMs : runFollowBackoffMs(failures);
						followBackoffRef.current = {
							failures,
							notBefore: Date.now() + delayMs,
						};
						const rateLimited =
							streamErr instanceof AtlasApiError && streamErr.status === 429;
						setError(
							rateLimited
								? `Muitas reconexões seguidas; tento de novo em ${Math.ceil(delayMs / 1000)}s.`
								: streamErr instanceof Error
									? streamErr.message
									: "A conexão com o run caiu.",
						);
						return;
					}
				}
				followBackoffRef.current = { failures: 0, notBefore: 0 };

				if (cancelled || abort.signal.aborted) return;
				const ended = await getAgentRun(runId).catch(() => null);
				if (ended?.run.usageJson && !abort.signal.aborted && !cancelled) receiveRunUsage(ended.run.usageJson);
				if (ended && decideRunFollow(ended.run.status) === "wait_user") {
					parkPaused();
					return;
				}
				// `done` visto no stream vale mesmo que o snapshot falhe (rede ainda voltando): a resposta está no banco.
				if (!(ended && TERMINAL_RUN_STATUSES.has(ended.run.status)) && !doneSeen) return;
				clearStoredActiveRunId(conversationId);
				clearStoredSseCursor(runId);
				if (!released) releaseFollow();
				await threadSync.sync({ runLive: false, resultText: ended?.run.resultText, retries: 3 });
			} finally {
				// Só libera se o onDone/terminal ainda não liberou — evita matar
				// um send novo que começou com activeRunId ainda null.
				if (!released && !parked && activeRunIdRef.current === runId) {
					releaseFollow();
				}
			}
		};

		(async () => {
			try {
				if (sendingRef.current || epoch !== transcriptEpochRef.current) {
					return;
				}
				const thread = await applyThread();
				if (cancelled) return;
				if (sendingRef.current || epoch !== transcriptEpochRef.current) {
					return;
				}
				if (!cancelled && !sendingRef.current) setMessages(thread);
				// Segue o run sem segurar o "carregando": pouso/leitura da conversa não esperam o fim do run.
				setLoading(false);

				const runId = await resolveActiveRunId(conversationId);
				if (cancelled || abort.signal.aborted || sendingRef.current) return;
				if (runId) {
					await followRun(runId);
				} else {
					// O run pode ter terminado entre o carregamento acima e agora: confere o fim de novo.
					await threadSync.sync({ runLive: false, retries: 1 });
				}
			} catch (err) {
				if (cancelled || abort.signal.aborted || isAbortLikeError(err)) {
					return;
				}
				console.error("load conversation failed", err);
				const message =
					err instanceof AtlasApiError
						? err.message
						: err instanceof Error
							? err.message
							: "Falha ao carregar conversa";
				setError(message);
			} finally {
				if (!cancelled) {
					setLoading(false);
					if (!sendingRef.current) setSending(false);
				}
			}
		})();

		// Anexa ao run ativo da conversa. Quem chama: o hub (evento de run / ressincronização) e a consulta de
		// segurança abaixo. Dentro do backoff de um stream que falhou, agenda a volta em vez de esperar um poll.
		let attachRetry: ReturnType<typeof setTimeout> | null = null;
		const tryAttach = () => {
			if (cancelled || abort.signal.aborted) return;
			if (sendingRef.current || activeRunIdRef.current) return;
			const wait = followBackoffRef.current.notBefore - Date.now();
			if (wait > 0) {
				if (attachRetry === null) {
					attachRetry = setTimeout(() => {
						attachRetry = null;
						tryAttach();
					}, wait + 50);
				}
				return;
			}
			void resolveActiveRunId(conversationId)
				.then((runId) => {
					if (!runId || cancelled || abort.signal.aborted) return;
					if (sendingRef.current || activeRunIdRef.current) return;
					return followRun(runId);
				})
				.catch((error) => {
					console.warn("attach active run failed", error);
				});
		};
		tryAttachRef.current = tryAttach;
		// Com o hub conectado, run novo/retomado chega por evento: sem consulta de 1 s. Sem hub (desligado ou
		// servidor antigo) é o comportamento de antes; com o hub fora do ar, só uma consulta de segurança lenta.
		let lastAttachPollAt = Date.now();
		const poll = window.setInterval(() => {
			if (!shouldPollTick(currentPollMode(), Date.now(), lastAttachPollAt)) return;
			lastAttachPollAt = Date.now();
			if (Date.now() < followBackoffRef.current.notBefore) return;
			tryAttach();
		}, 1000);

		return () => {
			cancelled = true;
			abort.abort();
			window.clearInterval(poll);
			if (attachRetry !== null) clearTimeout(attachRetry);
			if (tryAttachRef.current === tryAttach) tryAttachRef.current = null;
			if (threadSyncRef.current === threadSync) threadSyncRef.current = null;
		};
	}, [agentId, conversationId, clearRunRefs, loadConversationThread]);

	// Sessões de código criadas fora deste stream (rotina, outro dispositivo, demo): traz o cartão
	// e o estado atual a cada poucos segundos, só com a aba visível.
	useEffect(() => {
		if (!conversationId) return;
		let cancelled = false;
		let inFlight = false;
		const tick = async () => {
			if (inFlight || cancelled || document.visibilityState === "hidden") return;
			inFlight = true;
			try {
				await syncConversationDevSessions(conversationId, {
					runLive: Boolean(activeRunIdRef.current),
					setMessages,
					isStale: () => cancelled || conversationIdRef.current !== conversationId,
				});
			} catch {
				// próxima volta tenta de novo
			} finally {
				inFlight = false;
			}
		};
		let lastRunAt = Date.now();
		const timer = window.setInterval(() => {
			if (!shouldPollTick(currentPollMode(), Date.now(), lastRunAt)) return;
			lastRunAt = Date.now();
			void tick();
		}, SESSION_SYNC_MS);
		// Hub: a sessão de código mudou (estado, PR, job): traz o cartão e o estado sem esperar a consulta.
		let hubTimer: ReturnType<typeof setTimeout> | null = null;
		const offHub = getSharedEventHub()?.subscribeConversation(conversationId, (event) => {
			if (event.type !== "dev-session" && event.type !== "dev-job") return;
			if (hubTimer !== null) return;
			hubTimer = setTimeout(() => {
				hubTimer = null;
				void tick();
			}, 300);
		});
		return () => {
			cancelled = true;
			window.clearInterval(timer);
			offHub?.();
			if (hubTimer !== null) clearTimeout(hubTimer);
		};
	}, [conversationId, setMessages]);

	// Grupo: acompanha quem está roteando/respondendo (alimenta "Bia está respondendo…") e, quando a
	// fila esvazia sem ninguém acompanhando um run, recarrega a conversa (falas de runs rápidos).
	useEffect(() => {
		if (!groupId || !conversationId) return;
		let cancelled = false;
		let wasBusy = false;
		let inFlight = false;
		const tick = async () => {
			if (inFlight || cancelled || document.visibilityState === "hidden") return;
			inFlight = true;
			try {
				const state = await getGroupState(groupId);
				if (cancelled) return;
				setGroupState(state);
				const busy = state.routing || state.replies.length > 0;
				if (wasBusy && !busy && !activeRunIdRef.current && !sendingRef.current) {
					const refreshed = await loadConversationThread(conversationId);
					if (!cancelled && conversationIdRef.current === conversationId) {
						setMessages((previous) => trackSupersededBubbles(previous, reconcilePersistedThread(refreshed, previous, null), liveStateRef.current));
					}
				}
				wasBusy = busy;
			} catch (error) {
				if (!cancelled) console.warn("group state failed", error);
			} finally {
				inFlight = false;
			}
		};
		void tick();
		const timer = window.setInterval(() => void tick(), GROUP_STATE_POLL_MS);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [groupId, conversationId, loadConversationThread]);

	// Reação feita em outra aba/aparelho (ou do bot): o hub avisa e buscamos só as reações dessa mensagem.
	useEffect(() => {
		if (!conversationId) return;
		return getSharedEventHub()?.subscribeConversation(conversationId, (event) => {
			const messageId = event.payload.messageId;
			if (event.type === "message" && event.payload.op === "reaction" && typeof messageId === "string") void messageReactions.refresh(messageId);
		});
	}, [conversationId]);

	// Remetente parado esperando outro bot: traz para o fio o "X precisa de você" (e o
	// resolvido) que o worker grava sem run no remetente.
	const awaitingBot = useMemo(() => isAwaitingBot(messages), [messages]);
	useEffect(() => {
		if (!conversationId || !awaitingBot) return;
		let cancelled = false;
		const fetchMarkers = () => {
			if (sendingRef.current || activeRunIdRef.current) return;
			void fetchThreadPage(conversationId, { limit: 30 })
				.then((page) => {
					if (cancelled || conversationIdRef.current !== conversationId) return;
					setMessages((previous) => mergeNeedsUserMarkers(previous, page.messages));
				})
				.catch(() => undefined);
		};
		let lastRunAt = Date.now();
		const timer = window.setInterval(() => {
			if (!shouldPollTick(currentPollMode(), Date.now(), lastRunAt)) return;
			lastRunAt = Date.now();
			fetchMarkers();
		}, 4000);
		// Hub: o "X precisa de você" do outro bot chega como mensagem nova da conversa.
		const offHub = getSharedEventHub()?.subscribeConversation(conversationId, (event) => {
			if (event.type === "message") fetchMarkers();
		});
		return () => {
			cancelled = true;
			window.clearInterval(timer);
			offHub?.();
		};
	}, [conversationId, awaitingBot]);

	// Modo proativo: a reflexão e os lembretes gravam na conversa sem run visível; busca devagar, só ocioso e com a aba aberta.
	useEffect(() => {
		if (!watchExternal || !conversationId) return;
		let cancelled = false;
		const tick = async () => {
			if (document.visibilityState === "hidden" || sendingRef.current || activeRunIdRef.current) return;
			try {
				const page = await fetchThreadPage(conversationId, { limit: 15 });
				if (cancelled || conversationIdRef.current !== conversationId) return;
				if (sendingRef.current || activeRunIdRef.current) return;
				setMessages((previous) => mergeProposalStatuses(mergeExternalMessages(previous, page.messages), page.messages));
			} catch {
				// próxima volta tenta de novo
			}
		};
		let lastRunAt = Date.now();
		const timer = window.setInterval(() => {
			if (!shouldPollTick(currentPollMode(), Date.now(), lastRunAt)) return;
			lastRunAt = Date.now();
			void tick();
		}, PROACTIVE_WATCH_MS);
		const onVisible = () => {
			if (document.visibilityState === "visible") void tick();
		};
		document.addEventListener("visibilitychange", onVisible);
		// Hub: lembrete/sugestão/reflexão gravados na conversa chegam como mensagem nova.
		const offHub = getSharedEventHub()?.subscribeConversation(conversationId, (event) => {
			if (event.type === "message") void tick();
		});
		return () => {
			cancelled = true;
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
			offHub?.();
		};
	}, [watchExternal, conversationId, setMessages]);

	// Run que o cliente acompanhava e o servidor já deu por terminado (stream morto/congelado, estacionado,
	// aberto em outro aparelho): solta o composer e traz do servidor a resposta persistida.
	const finalizeTerminalRun = useCallback(async (runId: string, resultText?: string | null) => {
		const stillFollowed = activeRunIdRef.current === runId;
		clearRunRefs(runId);
		if (stillFollowed) {
			sendingRef.current = false;
			setSending(false);
		}
		await threadSyncRef.current?.sync({ runLive: false, resultText, retries: 3 });
	}, [clearRunRefs]);

	// Verifica no servidor o run acompanhado. Devolve se ele terminou (e já finalizou).
	const settleFollowedRun = useCallback(async (): Promise<boolean> => {
		const runId = activeRunIdRef.current;
		if (!runId) return false;
		const snapshot = await getAgentRun(runId).catch(() => null);
		if (!snapshot || activeRunIdRef.current !== runId) return false;
		if (!TERMINAL_RUN_STATUSES.has(snapshot.run.status)) return false;
		if (snapshot.run.usageJson) receiveRunUsage(snapshot.run.usageJson);
		await finalizeTerminalRun(runId, snapshot.run.resultText);
		return true;
	}, [finalizeTerminalRun, receiveRunUsage]);

	// Voltou do segundo plano (PWA/Android): SEMPRE busca o fim da conversa no servidor, com ou sem run
	// acompanhado (o stream pode estar congelado e o resultado só existir no banco). Se o run acompanhado já
	// terminou, finaliza na hora; senão o próprio streamAgentRun derruba a conexão congelada e reconecta pelo cursor.
	useEffect(() => {
		if (!conversationId) return;
		let cancelled = false;
		const unsubscribe = subscribeAppResume(() => {
			void (async () => {
				try {
					if (await settleFollowedRun()) return;
					const sync = threadSyncRef.current;
					if (!sync || cancelled || conversationIdRef.current !== conversationId) return;
					const followed = Boolean(activeRunIdRef.current);
					await sync.sync({ runLive: followed, retries: 2 });
					if (cancelled || followed || sendingRef.current || activeRunIdRef.current) return;
					const runId = await resolveActiveRunId(conversationId);
					if (!runId || cancelled || sendingRef.current || activeRunIdRef.current) return;
					// o poll de 1s do efeito principal reanexa o run; aqui só garante que não esperamos o backoff
					followBackoffRef.current = { failures: 0, notBefore: 0 };
				} catch {
					// o poll normal tenta de novo
				}
			})();
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [conversationId, settleFollowedRun]);

	// Run estacionado (pausado/aguardando o usuário) sem stream: se terminar por outro caminho (outro aparelho,
	// aprovação por notificação), nada mais avisaria este cliente. Confere no servidor, só com a aba visível.
	useEffect(() => {
		if (!conversationId) return;
		let inFlight = false;
		let lastRunAt = Date.now();
		const timer = window.setInterval(() => {
			if (inFlight || document.visibilityState === "hidden") return;
			if (!activeRunIdRef.current || sendingRef.current) return;
			// Com o hub conectado o fim do run chega por evento (efeito do hub abaixo): sem consulta de 5 s.
			if (!shouldPollTick(currentPollMode(), Date.now(), lastRunAt)) return;
			lastRunAt = Date.now();
			inFlight = true;
			void settleFollowedRun().catch(() => undefined).finally(() => {
				inFlight = false;
			});
		}, PARKED_RUN_CHECK_MS);
		return () => window.clearInterval(timer);
	}, [conversationId, settleFollowedRun]);

	// Sinal de fora do hook (lista de conversas/bolinhas: última mensagem ou não lidas mudaram): busca o fim.
	const syncFromServer = useCallback(async () => {
		if (await settleFollowedRun()) return;
		await threadSyncRef.current?.sync({ runLive: Boolean(activeRunIdRef.current), retries: 1 });
	}, [settleFollowedRun]);

	// Hub de eventos (um canal por usuário): mensagem/cartão novo, run que começou/pausou/terminou e
	// ressincronização chegam aqui por aviso; o estado sempre é buscado no servidor (thread-sync). O stream
	// do run aberto continua só para os tokens; o fim do run e as mensagens persistidas vêm pelo hub.
	useEffect(() => {
		if (!conversationId) return;
		const hub = getSharedEventHub();
		if (!hub) return;
		let cancelled = false;
		let syncTimer: ReturnType<typeof setTimeout> | null = null;
		let settleTimer: ReturnType<typeof setTimeout> | null = null;
		const stale = () => cancelled || conversationIdRef.current !== conversationId;
		const syncSoon = () => {
			if (syncTimer !== null) return;
			syncTimer = setTimeout(() => {
				syncTimer = null;
				if (stale()) return;
				// Envio em andamento sem run ainda: o próprio envio cuida da lista (não atropela o balão otimista).
				if (sendingRef.current && !activeRunIdRef.current) return;
				void threadSyncRef.current?.sync({ runLive: Boolean(activeRunIdRef.current), retries: 0 }).catch(() => undefined);
			}, 150);
		};
		// Fim do run acompanhado: dá um instante para o stream entregar o último trecho e então confere no servidor.
		const settleSoon = () => {
			if (settleTimer !== null) return;
			settleTimer = setTimeout(() => {
				settleTimer = null;
				if (stale()) return;
				void settleFollowedRun()
					.then((settled) => {
						if (!settled) syncSoon();
					})
					.catch(() => syncSoon());
			}, 1200);
		};
		const onEvent = (event: HubEvent) => {
			if (stale()) return;
			if (event.type === "message") {
				syncSoon();
				return;
			}
			if (event.type !== "run") return;
			const status = eventRunStatus(event);
			if (isActiveRunStatus(status) || isParkedRunStatus(status)) {
				tryAttachRef.current?.();
				if (isParkedRunStatus(status)) syncSoon();
				return;
			}
			if (isTerminalRunStatus(status)) {
				if (event.payload.runId === activeRunIdRef.current) settleSoon();
				else syncSoon();
			}
		};
		const offEvents = hub.subscribeConversation(conversationId, onEvent);
		const offResync = hub.onResync(() => {
			if (stale()) return;
			tryAttachRef.current?.();
			syncSoon();
			settleSoon();
		});
		return () => {
			cancelled = true;
			offEvents();
			offResync();
			if (syncTimer !== null) clearTimeout(syncTimer);
			if (settleTimer !== null) clearTimeout(settleTimer);
		};
	}, [conversationId, settleFollowedRun]);

	const applyBotProposalState = useCallback(
		(proposalId: string, change: BotProposalChange, confirmation?: { id: string; text: string }) => {
			setMessages((previous) => {
				const next = setBotProposalState(previous, proposalId, change);
				// A confirmação postada pelo servidor entra no chat sem recarregar (o id evita duplicar no refresh).
				if (!confirmation || next.some((item) => item.id === confirmation.id)) return next;
				return [...next, { id: confirmation.id, kind: "assistant", text: confirmation.text }];
			});
		},
		[],
	);

	const applyRoutineProposalState = useCallback(
		(id: string, change: RoutineProposalChange) => setMessages((previous) => setRoutineProposalState(previous, id, change)),
		[setMessages],
	);

	const setModel = useCallback(
		(next: string) => {
			// Vazio = Automático (modelos por dificuldade).
			const trimmed = next.trim();
			setModelState(trimmed);
			setServedModel(null);
			setRunUsage(null);
			setStoredAgentModel(agentId, trimmed);
		},
		[agentId],
	);

	useDevSessionFixture(!loading, setMessages, conversationId);

	const ensureConversation = useCallback(async (): Promise<string> => {
		if (conversationIdRef.current) {
			return conversationIdRef.current;
		}
		const id = await createConversation();
		conversationIdRef.current = id;
		return id;
	}, []);

	const cancelRun = useCallback(async () => {
		const runId = activeRunIdRef.current;
		sendAbortRef.current?.abort();
		reconnectAbortRef.current?.abort();
		// "Parar" também pausa a sessão de código da conversa (o servidor cancela o run junto).
		const stoppingConversation = conversationIdRef.current;
		if (stoppingConversation) void stopConversationDevSessions(stoppingConversation).catch(() => undefined);
		if (!runId) {
			sendingRef.current = false;
			setSending(false);
			setActivity({ phase: "idle" });
			return;
		}
		try {
			await cancelAgentRun(runId);
			const { run } = await getAgentRun(runId);
			if (
				run.status === "cancelled" ||
				run.status === "completed" ||
				run.status === "failed" ||
				run.status === "budget_exhausted"
			) {
				const conversationId = conversationIdRef.current;
				if (conversationId) clearStoredActiveRunId(conversationId);
				clearStoredSseCursor(runId);
				activeRunIdRef.current = null;
				setActiveRunId(null);
				setRunStatus(null);
				sendingRef.current = false;
				setSending(false);
				setActivity({ phase: "idle" });
			}
		} catch (error) {
			// Run sumiu no servidor: solta o ref em vez de grudar nele.
			if (error instanceof AtlasApiError && error.status === 404) {
				clearRunRefs(runId);
				sendingRef.current = false;
				setSending(false);
				return;
			}
			console.error("cancel run failed", error);
			setError("Não foi possível cancelar agora; o run continua ativo.");
		}
	}, [clearRunRefs]);

	const pauseRun = useCallback(async () => {
		const runId = activeRunIdRef.current;
		if (!runId) return;
		try {
			await pauseAgentRun(runId);
			setRunStatus("pausing");
		} catch (error) {
			console.error("pause run failed", error);
			setError("Não foi possível pausar agora; o agente continua trabalhando.");
		}
	}, []);

	// Anexa o stream a um run vivo (retomada manual ou auto-resume após steer
	// em run pausado). Não mexe em flags de envio — quem chama gerencia.
	const streamLiveRun = useCallback(
		async (
			targetRunId: string,
			convId: string,
			signal: AbortSignal,
		): Promise<void> => {
			const handlers = createComputerHandlers({
				runId: targetRunId,
				liveState: liveStateRef.current,
				onSandboxSession: (session) => onSandboxSessionRef.current?.(session),
				onRoutine: (event) => onRoutineRef.current?.(event),
					onAgentPointer: (event) => onAgentPointerRef.current?.(event),
				onRunId: (id) => {
					setActiveRunId(id);
					activeRunIdRef.current = id;
					setStoredActiveRunId(convId, id);
				},
				onPaused: () => setRunStatus("paused"),
				onServedModel: setServedModel,
				onUsage: receiveRunUsage,
				onCancelled: () => {
					clearRunRefs(targetRunId);
					setError("A execução foi cancelada.");
				},
				onStreamingMessage: setStreamingMessageId,
				onStatus: (status, detail) => {
					setRunStatus(status);
					if (status === "stale" || status === "retrying") {
						setError(
							detail ??
								"O worker parou. Confira Redis e se `pnpm --filter worker dev` está no ar.",
						);
					}
				},
				onActivity: () => setError(null),
				onAgentActivity: setActivity,
				onDone: () => {
					clearStoredActiveRunId(convId);
					clearStoredSseCursor(targetRunId);
					activeRunIdRef.current = null;
					setActiveRunId(null);
					setRunStatus(null);
					setActivity({ phase: "idle" });
				},
				setMessages,
			});
			await streamAgentRun(targetRunId, handlers, { signal });
			const snapshot = await getAgentRun(targetRunId);
			if (snapshot.run.usageJson && !signal?.aborted) receiveRunUsage(snapshot.run.usageJson);
			setRunStatus(snapshot.run.status);
			if (TERMINAL_RUN_STATUSES.has(snapshot.run.status)) {
				clearRunRefs(targetRunId);
			}
		},
		[clearRunRefs],
	);

	const resumeRun = useCallback(async (options: { via?: "vault" | "code"; code?: string } = {}) => {
		const runId = activeRunIdRef.current;
		const currentConversationId = conversationIdRef.current;
		if (!runId || !currentConversationId) return;
		try {
			// O servidor já pode ter retomado sozinho (conexão feita no Marketplace ou mensagem
			// enviada): se o run não está mais parado, só acompanha em vez de falhar o resume.
			const current = await getAgentRun(runId).then((snapshot) => snapshot.run.status).catch(() => null);
			if (current && TERMINAL_RUN_STATUSES.has(current)) return;
			let status = current;
			if (current !== "queued" && current !== "running" && current !== "retrying") {
				const { run, enqueued } = await resumeAgentRun(runId, options);
				if (!enqueued) throw new Error("Não foi possível retomar o agente");
				status = run.status;
			}
			followBackoffRef.current = { failures: 0, notBefore: 0 };
			setError(null);
			setRunStatus(status ?? "queued");
			sendingRef.current = true;
			setSending(true);
			setActivity({ phase: "thinking" });
			const abort = new AbortController();
			sendAbortRef.current?.abort();
			sendAbortRef.current = abort;
			await streamLiveRun(runId, currentConversationId, abort.signal);
		} catch (error) {
			if (!isAbortLikeError(error)) {
				console.error("resume run failed", error);
				setError("Não foi possível retomar agora. Tente novamente em instantes.");
			}
		} finally {
			sendingRef.current = false;
			setSending(false);
			if (!activeRunIdRef.current) {
				setActivity({ phase: "idle" });
			}
		}
	}, [streamLiveRun]);

	/** `/compact [foco]`: resume a conversa levada; um clique duplo não dispara duas compactações. */
	const compact = useCallback(async (focus?: string) => {
		const convId = conversationIdRef.current;
		if (compactingRef.current) return;
		if (!convId || groupId) {
			setCompactState({ status: "notice", text: groupId ? "Conversas de grupo não podem ser compactadas." : "Ainda não há conversa para compactar." });
			return;
		}
		compactingRef.current = true;
		setCompactState({ status: "working" });
		try {
			const result = await compactConversation(convId, focus);
			if (conversationIdRef.current !== convId) {
				setCompactState(null);
				return;
			}
			if (result.status === "compacted") {
				setCompactState(null);
				setMessages((previous) =>
					previous.some((item) => item.id === result.messageId)
						? previous
						: [...previous, { id: result.messageId, kind: "compaction", before: result.before, after: result.after, summary: result.card.summary, ...(result.card.focus ? { focus: result.card.focus } : {}) }],
				);
			} else {
				setCompactState({ status: "notice", text: result.message });
			}
		} catch (err) {
			setCompactState({ status: "notice", text: err instanceof Error && err.message ? err.message : "Não foi possível compactar a conversa." });
		} finally {
			compactingRef.current = false;
		}
	}, [groupId]);
	// O aviso curto some sozinho.
	useEffect(() => {
		if (compactState?.status !== "notice") return;
		const timer = setTimeout(() => setCompactState(null), 8_000);
		return () => clearTimeout(timer);
	}, [compactState]);

	const sendMessage = useCallback(
		async (text: string, outgoing: OutgoingAttachment[] = [], options: { confirmId?: string } = {}) => {
			// Imagens e arquivos seguem juntos em `attachments` (o servidor separa pelo tipo); o cartão otimista difere.
			const attachments = outgoing.map(({ artifactId }) => ({ artifactId }));
			const imageAttachments = outgoing.filter((item) => !item.file);
			const trimmed = text.trim();
			if (!trimmed && attachments.length === 0) return;

			const userMessage: Message = {
				id: nextMessageId(),
				kind: "user",
				text: trimmed,
			};
			const imageMessage: Message | null = imageAttachments.length ? {
				id: `images-${userMessage.id}`,
				kind: "images",
				source: "user",
				items: imageAttachments.map(({ artifactId }) => ({ artifactId, mime: "image/jpeg", width: 320, height: 320 })),
			} : null;
			const fileMessages: Message[] = outgoing.flatMap((item): Message[] => item.file
				? [{ id: `file-${item.artifactId}`, kind: "file", artifactId: item.artifactId, filename: item.file.name, mime: item.file.mime, size: item.file.size, origin: "user" }]
				: []);
			const optimisticMessages = [userMessage, ...(imageMessage ? [imageMessage] : []), ...fileMessages];

			setError(null);
			setServedModel(null);
			setRunUsage(null);

			// Grupo: a fala vai ao grupo (o servidor escolhe quem responde). Nunca vira "steer" no run de um membro.
			if (groupId && trimmed && !isCardProtocolText(trimmed)) {
				const convId = conversationIdRef.current;
				if (!convId) return;
				setMessages((previous) => [...previous, userMessage]);
				try {
					await postGroupMessage(groupId, trimmed);
					const refreshed = await loadConversationThread(convId);
					if (conversationIdRef.current === convId) {
						setMessages((previous) => trackSupersededBubbles(previous, reconcilePersistedThread(refreshed, previous, null), liveStateRef.current));
					}
					// Já mostra "escolhendo quem responde…" sem esperar o próximo ciclo.
					setGroupState((previous) => previous ?? { routing: true, replies: [] });
				} catch (err) {
					setMessages((previous) => previous.filter((item) => item.id !== userMessage.id));
					setError(
						err instanceof AtlasApiError
							? err.message
							: err instanceof Error
								? err.message
								: "Não foi possível enviar para o grupo",
					);
				}
				return;
			}

			// Clique de cartão (confirmar/cancelar) nunca vira input do run vivo: o servidor o resolve contra a
			// intenção pendente (POST /v1/runs). Como input ele só virava um balão "confirmado" a mais, sem
			// aprovar nada, e o run seguia esperando.
			const liveRunId = groupId || isCardProtocolText(trimmed) ? null : activeRunIdRef.current;
			if (liveRunId) {
				// Nunca enterra mensagem em run morto: confere antes de steer.
				let liveStatus: string | null = null;
				try {
					liveStatus = (await getAgentRun(liveRunId)).run.status;
				} catch {
					liveStatus = null;
				}
				if (liveStatus && !TERMINAL_RUN_STATUSES.has(liveStatus)) {
					setMessages((previous) => [...previous, ...optimisticMessages]);
					const clientKey =
						typeof crypto !== "undefined" && "randomUUID" in crypto
							? crypto.randomUUID()
							: `${Date.now()}-${Math.random().toString(36).slice(2)}`;
					try {
						await createRunInput(liveRunId, {
							content: trimmed,
							...(attachments.length ? { attachments } : {}),
							mode: "join",
							clientKey,
						});
					} catch (err) {
						if (err instanceof AtlasApiError && err.status === 409) {
							// O run terminou entre o check e o envio: remove a
							// otimista e cai no fluxo de run novo abaixo.
							setMessages((previous) =>
								previous.filter((item) => item.id !== userMessage.id && item.id !== imageMessage?.id && !fileMessages.some((file) => file.id === item.id)),
							);
							clearRunRefs(liveRunId);
						} else {
							const message =
								err instanceof AtlasApiError
									? err.message
									: err instanceof Error
										? err.message
										: "Falha ao enviar input";
							setError(message);
							return;
						}
					}
					if (activeRunIdRef.current === liveRunId) {
						if (liveStatus === "paused") {
							// Pausou, digitou, enviou: volta a trabalhar sozinho.
							const convId = conversationIdRef.current;
							if (convId) {
								try {
									sendingRef.current = true;
									setSending(true);
									setActivity({ phase: "thinking" });
									const abort = new AbortController();
									sendAbortRef.current?.abort();
									sendAbortRef.current = abort;
									await streamLiveRun(liveRunId, convId, abort.signal);
								} catch (err) {
									if (!isAbortLikeError(err)) {
										setError(
											err instanceof Error
												? err.message
												: "Não foi possível retomar agora.",
										);
									}
								} finally {
									sendingRef.current = false;
									setSending(false);
								}
							}
						}
						return;
					}
					// Caiu para run novo: a otimista saiu, o fluxo abaixo anexa.
				} else {
					clearRunRefs(liveRunId);
				}
			}

			// Envio anterior ainda criando o run: a fala entra na fila (o composer já limpou o texto) e segue como input
			// do run assim que ele existir, na ordem digitada.
			if (sendingRef.current && !activeRunIdRef.current) {
				sendQueueRef.current.push({ text, outgoing, options });
				return;
			}

			sendingRef.current = true;
			transcriptEpochRef.current += 1;
			setSending(true);
			setActivity({ phase: "thinking" });

			const pendingId = nextMessageId();
			setMessages((previous) => [...previous, ...optimisticMessages]);

			const abort = new AbortController();
			sendAbortRef.current?.abort();
			sendAbortRef.current = abort;

			try {
				const conversationId = await ensureConversation();
				const historyForApi = threadToChatMessages([userMessage]);

				const appendDelta = (delta: string) => {
					setActivity({ phase: "writing" });
					setStreamingMessageId(pendingId);
					setMessages((previous) =>
						previous.map((message) =>
							message.id === pendingId && message.kind === "assistant"
								? { ...message, text: `${message.text}${delta}` }
								: message,
						),
					);
				};

				{
					let created: CreateAgentRunResult | null = null;
					try {
						created = await withActiveRunConflictRetry(
							() =>
								createAgentRun({
									messages: historyForApi,
									...(attachments.length ? { attachments } : {}),
									...(options.confirmId ? { decisionConfirmId: options.confirmId } : {}),
									conversationId,
									botId: agentId,
									...(model ? { model } : { modelAuto: true }),
									...(sandboxSessionId ? { sandboxSessionId } : {}),
								}),
							abort.signal,
						);
					} catch (err) {
						// Fila fora do ar: responde simples em vez de quebrar.
						// O modelo decide sem ferramentas; sem run durável.
						if (err instanceof AtlasApiError && canUseLegacyChat(model, err.status, attachments.length)) {
							setError("Fila indisponível — respondendo sem ferramentas.");
							setMessages((previous) => [
								...previous,
								{ id: pendingId, kind: "assistant" as const, text: "" },
							]);
							await streamChatCompletion(
								{
									messages: historyForApi,
									conversationId,
									botId: agentId,
									model,
								},
								{ onDelta: appendDelta },
								{ signal: abort.signal },
							);
							return;
						}
						throw err;
					}
					// O bot só reagiu (ex.: "valeu!"): a mensagem foi salva, não há run nem "trabalhando".
					if (created.runId === null) {
						const refreshed = await loadConversationThread(conversationId);
						if (conversationIdRef.current === conversationId) {
							setMessages((previous) => trackSupersededBubbles(previous, reconcilePersistedThread(refreshed, previous, null), liveStateRef.current));
						}
						return;
					}
					const { runId } = created;

					if (
						abort.signal.aborted &&
						shouldCancelCreatedRun({
							createdForConversationId: conversationId,
							visibleConversationId: conversationIdRef.current,
						})
					) {
						await cancelAgentRun(runId).catch(() => undefined);
						return;
					}
					if (abort.signal.aborted) {
						return;
					}

					setActiveRunId(runId);
					markRunLive(runId);
					activeRunIdRef.current = runId;
					setRunStatus("queued");
					setStoredActiveRunId(conversationId, runId);
					flushQueuedSends();
					if (created.enqueued === false) {
						setError("Pedido salvo. Aguardando a recuperação do serviço para continuar.");
					}

					const handlers = createComputerHandlers({
						runId,
						liveState: liveStateRef.current,
						onSandboxSession: (session) => {
							onSandboxSessionRef.current?.(session);
						},
						onRoutine: (event) => onRoutineRef.current?.(event),
					onAgentPointer: (event) => onAgentPointerRef.current?.(event),
						onRunId: (id) => {
							setActiveRunId(id);
							activeRunIdRef.current = id;
							setStoredActiveRunId(conversationId, id);
						},
						onPaused: () => setRunStatus("paused"),
						onServedModel: setServedModel,
						onUsage: receiveRunUsage,
						onCancelled: () => {
							clearRunRefs(runId);
							setError("A execução foi cancelada.");
						},
						onStreamingMessage: setStreamingMessageId,
						onStatus: (status, detail) => {
							setRunStatus(status);
							if (status === "stale" || status === "retrying") {
								setError(
									detail ??
										"O worker parou. Confira Redis e se `pnpm --filter worker dev` está no ar.",
								);
							}
						},
						onActivity: () => setError(null),
						onAgentActivity: setActivity,
						onDone: () => {
							clearStoredActiveRunId(conversationId);
							clearStoredSseCursor(runId);
							activeRunIdRef.current = null;
							setActiveRunId(null);
							setRunStatus(null);
							setActivity({ phase: "idle" });
						},
						setMessages,
					});

					await streamAgentRun(runId, handlers, { signal: abort.signal });
					if (!abort.signal.aborted) {
						const snapshot = await getAgentRun(runId).catch(() => null);
						if (snapshot?.run.usageJson && !abort.signal.aborted) receiveRunUsage(snapshot.run.usageJson);
						if (snapshot && TERMINAL_RUN_STATUSES.has(snapshot.run.status)) {
							clearStoredActiveRunId(conversationId);
							clearStoredSseCursor(runId);
							activeRunIdRef.current = null;
							setActiveRunId(null);
							try {
								const refreshed = await loadConversationThread(conversationId);
								if (conversationIdRef.current === conversationId) {
									setMessages((previous) => conversationIdRef.current === conversationId
										? trackSupersededBubbles(previous, reconcilePersistedThread(refreshed, previous, snapshot.run.resultText), liveStateRef.current)
										: previous);
								}
							} catch (error) {
								console.warn("refresh conversation after run failed", error);
							}
						}
					}
				}
			} catch (err) {
				if (isAbortLikeError(err) || abort.signal.aborted) return;
				const message =
					err instanceof AtlasApiError
						? err.message
						: err instanceof Error
							? err.message
							: "Erro ao enviar mensagem";
				setError(message);
				if (!activeRunIdRef.current) {
					setMessages((previous) =>
						previous.filter(
							(item) =>
								item.id !== pendingId &&
								!(item.kind === "assistant" && item.text.trim().length === 0),
						),
					);
				}
			} finally {
				const stillCurrentSend = sendAbortRef.current === abort;
				if (stillCurrentSend) {
					sendAbortRef.current = null;
					sendingRef.current = false;
					setSending(false);
					setStreamingMessageId(null);
					if (!activeRunIdRef.current) {
						setActivity({ phase: "idle" });
					}
				}
				// A criação do run falhou (ou o envio acabou sem run): o que ficou na fila vira um envio normal.
				flushQueuedSends();
			}
		},
		[agentId, groupId, ensureConversation, model, sandboxSessionId, streamLiveRun, clearRunRefs, loadConversationThread, flushQueuedSends],
	);
	sendMessageRef.current = sendMessage;

	const setLoginStatus = useCallback(
		(id: string, status: "pending" | "done") => {
			setMessages((previous) =>
				previous.map((item) =>
					item.kind === "login" && (item.id === id || item.loginId === id)
						? { ...item, status }
						: item,
				),
			);
		},
		[],
	);

	const setConfirmStatus = useCallback(
		(id: string, status: NonNullable<Extract<Message, { kind: "confirm" }>["status"]>) => {
			setMessages((previous) =>
				previous.map((item) =>
					item.kind === "confirm" && (item.id === id || item.confirmId === id)
						? { ...item, status }
						: item,
				),
			);
		},
		[],
	);

	const setQuestionnaireStatus = useCallback(
		(id: string, status: QuestionnaireStatus, answers?: QuestionnaireAnswersData) => {
			setMessages((previous) =>
				previous.map((item) =>
					item.kind === "questionnaire" &&
					(item.id === id || item.questionnaireId === id)
						? { ...item, status, ...(answers ? { answers } : {}) }
						: item,
				),
			);
		},
		[],
	);

	const setBotProfileStatus = useCallback(
		(id: string, status: "pending" | "approved" | "rejected") => {
			setMessages((previous) =>
				previous.map((item) =>
					item.kind === "bot-profile-confirm" && item.id === id
						? { ...item, status }
						: item,
				),
			);
		},
		[],
	);

	// Gate humano das skills: o card muda de estado no ato (otimista) e volta ao erro se o servidor recusar.
	const applySkillProposalState = useCallback(
		(proposalId: string, change: "applying" | "approved" | "rejected" | { error: string }) => {
			setMessages((previous) =>
				typeof change === "object"
					? setSkillProposalError(previous, proposalId, change.error)
					: change === "applying"
						? setSkillProposalApplying(previous, proposalId, true)
						: setSkillProposalStatus(previous, proposalId, change),
			);
		},
		[],
	);

	// "Editar antes" resolve a proposta lá nas Configurações: o card daqui acompanha.
	useEffect(
		() =>
			subscribeSkillProposalResolved(({ proposalId, status }) =>
				setMessages((previous) => setSkillProposalStatus(previous, proposalId, status)),
			),
		[],
	);

	const dismissMessage = useCallback((id: string) => {
		const convId = conversationIdRef.current;
		if (convId) {
			try {
				const key = `atlas:dismissed:${convId}`;
				const raw = localStorage.getItem(key);
				const arr = raw ? (JSON.parse(raw) as unknown) : [];
				const list = Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : [];
				if (!list.includes(id)) localStorage.setItem(key, JSON.stringify([...list, id]));
			} catch {
				// storage indisponível: dispensa só na sessão
			}
		}
		setMessages((previous) => previous.filter((m) => m.id !== id));
	}, []);

	return {
		messages,
		hasMoreHistory,
		loadingOlder,
		loadOlderMessages,
		sending,
		loading,
		error,
		sendMessage,
		compact,
		compactState,
		dismissMessage,
		setConfirmStatus,
		setLoginStatus,
		setQuestionnaireStatus,
		setBotProfileStatus,
		applySkillProposalState,
		applyRoutineProposalState,
		applyBotProposalState,
		cancelRun,
		pauseRun,
		resumeRun,
		model,
		setModel,
		activeRunId,
		liveBotId,
		groupState,
		runStatus,
		servedModel,
		runUsage,
		activity,
		streamingMessageId,
		syncFromServer,
	};
}
