import { getAccountConfig, getReactionStateContext, recordReactionOnlyReply } from "@workspace/db";
import { detectReactionOnly, type JevRuntime } from "@workspace/agent-runtime";
import {
	classifyReactionOnly,
	isAmbiguousShortMessage,
	reactionOnlyBlock,
	type BotReactionEmoji,
	type CreateAgentRunRequest,
	type JevMode,
	type ReactionOnlyRunResponse,
} from "@workspace/shared";
import { loadEffectiveConfig } from "./account-config.js";
import { buildJevIntentRuntime } from "./jev-intent.js";

/**
 * "Responder só com reação": decide ANTES de criar o run se a mensagem do usuário não precisa de resposta.
 * Camada 1 (regras, custo zero) e camada 2 (Jev, só mensagens curtas e ambíguas) só valem com as travas
 * liberadas (`reactionOnlyBlock`). Qualquer falha devolve `handled: false` e o fluxo segue como sempre.
 */

export type ReactionOnlyDeps = {
	/** Ligado na conta? E em que modo está o Jev de intenção (a camada 2 só roda com `on`). */
	loadSettings: (userId: string) => Promise<{ enabled: boolean; jevMode: JevMode }>;
	getState: typeof getReactionStateContext;
	detect: (input: { text: string; previousAssistantMessage?: string }) => Promise<BotReactionEmoji | null>;
	record: typeof recordReactionOnlyReply;
	now?: () => Date;
};

export type ReactionOnlyOutcome = { handled: false } | { handled: true; response: ReactionOnlyRunResponse };

export function lastUserText(request: Pick<CreateAgentRunRequest, "messages">): string | null {
	const last = request.messages[request.messages.length - 1];
	return last?.role === "user" ? last.content.trim() : null;
}

export async function maybeReactOnly(input: { request: CreateAgentRunRequest; userId: string; deps: ReactionOnlyDeps }): Promise<ReactionOnlyOutcome> {
	const { request, userId, deps } = input;
	const NO: ReactionOnlyOutcome = { handled: false };
	const text = lastUserText(request);
	// Só conversa 1:1 de chat com bot, sem anexo, objetivo próprio, clique de cartão ou run silencioso.
	if (!text || !request.conversationId || !request.botId || request.objective?.trim()) return NO;
	if ((request.origin ?? "chat") !== "chat" || Boolean(request.silent) || request.attachments?.length || request.decisionConfirmId) return NO;

	const rule = classifyReactionOnly(text);
	if (!rule && !isAmbiguousShortMessage(text)) return NO;

	try {
		const settings = await deps.loadSettings(userId);
		if (!settings.enabled) return NO;
		const state = await deps.getState({ userId, conversationId: request.conversationId, now: (deps.now ?? (() => new Date()))() });
		const block = reactionOnlyBlock({
			enabled: settings.enabled,
			origin: request.origin,
			silent: Boolean(request.silent),
			hasAttachments: Boolean(request.attachments?.length),
			hasDecisionConfirm: Boolean(request.decisionConfirmId),
			now: (deps.now ?? (() => new Date()))(),
			...state,
		});
		if (block) return NO;
		let emoji: BotReactionEmoji | null = rule?.emoji ?? null;
		if (!emoji && settings.jevMode === "on") {
			emoji = await deps.detect({ text, previousAssistantMessage: state.previous?.text });
		}
		if (!emoji) return NO;
		const saved = await deps.record({ userId, botId: request.botId, conversationId: request.conversationId, content: text, emoji });
		if (!saved) return NO;
		console.info(`[reaction-only] layer=${rule ? "rule" : "jev"}`);
		return { handled: true, response: { runId: null, status: "reacted", enqueued: true, messageId: saved.messageId, reaction: saved.emoji } };
	} catch (error) {
		console.warn(`[reaction-only] caiu no fluxo normal reason=${error instanceof Error ? error.name : "unknown"}`);
		return NO;
	}
}

/** Ligações reais: configuração da conta, banco e (camada 2) Jev com a mesma chave da API. */
export function createReactionOnlyDeps(options: { apiKey: string | undefined; loadAccount?: typeof getAccountConfig; env?: NodeJS.ProcessEnv }): ReactionOnlyDeps {
	return {
		async loadSettings(userId) {
			const effective = await loadEffectiveConfig(userId, options.env ?? process.env, options.loadAccount);
			return { enabled: effective.execution.reactionOnly.value, jevMode: effective.jev.features.intent.value };
		},
		getState: getReactionStateContext,
		async detect({ text, previousAssistantMessage }) {
			const rt: JevRuntime | undefined = buildJevIntentRuntime(options.apiKey, options.env ?? process.env, "on");
			return detectReactionOnly({ rt, latestUserMessage: text, previousAssistantMessage });
		},
		record: recordReactionOnlyReply,
	};
}
