import type { ChatTool } from "@workspace/llm";
import {
	BOT_MESSAGE_MAX_CHARS,
	SEND_TO_BOT_TOOL_NAME,
	SET_PRIMARY_BOT_TOOL_NAME,
	resolveTargetBot,
	type BotRosterEntry,
} from "@workspace/shared";
import {
	BotMessageError,
	listUserBotRoster,
	saveSkillPendingIntent,
	sendBotMessage,
	type SendBotMessageResult,
} from "@workspace/db";
import { isUnattendedOrigin } from "../autonomy-gate.js";

/**
 * Conversa entre bots. `send_to_bot` só grava a mensagem (o worker entrega ao
 * destino e devolve a resposta sozinho); `set_primary_bot` só propõe: o bot
 * principal muda quando o usuário confirma o card.
 */

export { SEND_TO_BOT_TOOL_NAME, SET_PRIMARY_BOT_TOOL_NAME };

export const SEND_TO_BOT_TOOL: ChatTool = {
	type: "function",
	function: {
		name: SEND_TO_BOT_TOOL_NAME,
		description:
			"Send a message to another bot of the same user (each bot has its own memory, connectors, routines and VM). Use it proactively, without waiting to be told: when the request falls clearly in another bot's role or expertise (per the roster name/label/description), or that bot has the context, memory or connectors needed, send it instead of doing it yourself; if the user explicitly asks you to ask a bot, always do it. Do not use it for things you can do yourself or trivial ones, to talk to the user, or to message yourself, and never bounce a request back and forth between bots (do not send back to a bot that just asked you something). The message is delivered asynchronously: this call returns at once and the target's answer arrives later as a message that starts with \"Resposta do bot …\", waking you to report it. After sending, tell the user briefly what you asked and of whom (e.g. \"pedi pro X, te aviso quando responder\") and END YOUR TURN: do not wait, poll or invent the answer. If YOU are answering a message from another bot, just answer in your final reply (it is returned automatically); use this tool only if you must ask a third bot, and then end your turn (your reply to the first bot is sent when the third answers).",
		parameters: {
			type: "object",
			properties: {
				bot: { type: "string", description: "Target bot id or name (from the list of the user's other bots)" },
				message: {
					type: "string",
					description: "Self-contained request for the target bot: it does not see your conversation. Include the context and what you expect back.",
				},
				title: { type: "string", description: "Very short summary of the request (max ~8 words)" },
			},
			required: ["bot", "message", "title"],
		},
	},
};

export const SET_PRIMARY_BOT_TOOL: ChatTool = {
	type: "function",
	function: {
		name: SET_PRIMARY_BOT_TOOL_NAME,
		description:
			"Propose marking a bot as the user's \"Bot principal\" (the one that coordinates and delegates to the other bots). Use ONLY after the user agreed to set one, and only when none is set. It shows a confirmation card; nothing changes until the user confirms. Omit `bot` to propose yourself.",
		parameters: {
			type: "object",
			properties: { bot: { type: "string", description: "Bot id or name; default is the current bot" } },
		},
	},
};

/** `send_to_bot` existe com 2+ bots, em conversa de chat ou de bot (nunca rotina/webhook/subagente). */
export function shouldExposeSendToBot(input: { origin: string | undefined; botCount: number }): boolean {
	return input.botCount >= 2 && (input.origin === "chat" || input.origin === "bot");
}

/** `set_primary_bot` só com humano no chat, 2+ bots e nenhum principal ainda. */
export function shouldExposeSetPrimaryBot(input: { origin: string | undefined; botCount: number; hasPrimary: boolean }): boolean {
	return input.botCount >= 2 && !input.hasPrimary && input.origin === "chat" && !isUnattendedOrigin(input.origin);
}

export type SendToBotDeps = {
	send: (input: Parameters<typeof sendBotMessage>[0]) => Promise<SendBotMessageResult>;
};

const sendDefaults: SendToBotDeps = { send: sendBotMessage };

export async function executeSendToBot(
	args: Record<string, unknown>,
	ctx: { userId: string | undefined; botId: string | undefined; runId?: string; origin: string | undefined },
	deps: SendToBotDeps = sendDefaults,
): Promise<{ summary: string }> {
	if (ctx.origin !== "chat" && ctx.origin !== "bot") {
		throw new Error("send_to_bot só funciona em conversas (não em rotinas, webhooks ou subagentes).");
	}
	const bot = typeof args.bot === "string" ? args.bot.trim() : "";
	const message = typeof args.message === "string" ? args.message.trim() : "";
	const title = typeof args.title === "string" ? args.title : "";
	if (!bot) throw new Error('Informe "bot" (nome ou id do bot de destino).');
	if (!message) throw new Error('Informe "message" com o pedido para o outro bot.');
	if (message.length > BOT_MESSAGE_MAX_CHARS) {
		throw new Error(`Mensagem longa demais (máx. ${BOT_MESSAGE_MAX_CHARS} caracteres).`);
	}
	if (!ctx.userId || ctx.userId === "default") throw new Error("Sem usuário neste run: mensagem não enviada.");
	try {
		const sent = await deps.send({ userId: ctx.userId, fromBotId: ctx.botId, fromRunId: ctx.runId, bot, message, title });
		return {
			summary: JSON.stringify({
				delivered: true,
				target: sent.targetName,
				targetId: sent.targetId,
				messageId: sent.id,
				note: "Message queued; the answer will arrive later as a message from that bot. Tell the user what you asked and end your turn.",
			}),
		};
	} catch (error) {
		if (error instanceof BotMessageError) throw new Error(error.message);
		throw error;
	}
}

export type SetPrimaryBotDeps = {
	roster: (userId: string) => Promise<BotRosterEntry[]>;
	savePending: typeof saveSkillPendingIntent;
};

const primaryDefaults: SetPrimaryBotDeps = { roster: listUserBotRoster, savePending: saveSkillPendingIntent };

export type SetPrimaryBotOutcome = {
	summary: string;
	card: { type: "confirm"; confirmId: string; title: string; description: string; confirmLabel: string; cancelLabel: string };
};

export async function executeSetPrimaryBot(
	args: Record<string, unknown>,
	ctx: { userId: string | undefined; botId: string | undefined; conversationId: string | undefined; runId?: string; origin: string | undefined },
	deps: SetPrimaryBotDeps = primaryDefaults,
): Promise<SetPrimaryBotOutcome> {
	if (ctx.origin !== "chat") throw new Error("O bot principal só muda numa conversa com o usuário.");
	if (!ctx.userId || ctx.userId === "default" || !ctx.botId || !ctx.conversationId) {
		throw new Error("Sem conversa de bot neste run: nada foi alterado.");
	}
	const roster = await deps.roster(ctx.userId);
	if (roster.length < 2) throw new Error("O usuário tem só um bot: não há o que coordenar.");
	if (roster.some((bot) => bot.isPrimary)) {
		throw new Error("Já existe um bot principal. Peça para o usuário trocar nas configurações do bot.");
	}
	const wanted = typeof args.bot === "string" ? args.bot.trim() : "";
	let target: BotRosterEntry | undefined;
	if (!wanted) {
		target = roster.find((bot) => bot.id === ctx.botId);
	} else {
		const self = roster.find((bot) => bot.id === ctx.botId);
		if (self && (wanted === self.id || wanted.toLowerCase() === self.name.trim().toLowerCase())) {
			target = self;
		} else {
			const resolved = resolveTargetBot(wanted, roster, ctx.botId);
			if (!resolved.ok) throw new Error(resolved.error);
			target = resolved.bot;
		}
	}
	if (!target) throw new Error("Bot não encontrado.");
	const confirmId = `confirm-${ctx.runId ?? "local"}`;
	await deps.savePending({
		userId: ctx.userId,
		conversationId: ctx.conversationId,
		payload: { kind: "confirm", action: "set-primary-bot", confirmId, botId: ctx.botId, primaryBot: { botId: target.id, name: target.name } },
	});
	const card = {
		type: "confirm" as const,
		confirmId,
		title: `Definir ${target.name} como bot principal?`,
		description: "O bot principal coordena os outros e delega a eles quando faz sentido. Você pode trocar depois nas configurações do bot.",
		confirmLabel: "Definir",
		cancelLabel: "Agora não",
	};
	return {
		summary: "Card de confirmação enviado. Nada mudou ainda; aguarde a escolha do usuário e não repita o pedido.",
		card,
	};
}
