import type { ChatTool } from "@workspace/llm";
import {
	autoDecisionNote,
	buildAutoDecisionCard,
	decideBotPending,
	decideBotQuestionnaire,
	type BotAutoDecisionCard,
	type BotNeed,
	type BotPendingItem,
	type PendingJevVerdict,
	type PendingProposal,
	type PendingRelayReason,
} from "@workspace/shared";
import {
	botDecidesForOthers,
	chainUserRequest,
	countAutoDecisions,
	escalatePendingNeed,
	findPendingForOrchestrator,
	getBotName,
	isChainAttended,
	queueAutoDecision,
} from "@workspace/db";
import { isUnattendedOrigin } from "../autonomy-gate.js";
import { clipForJev, decideWithJev, jevModeFor, type JevRuntime } from "../jev/decide.js";

/**
 * "Decidir pelos outros bots": o orquestrador responde (ou escala) o card que um bot
 * de destino deixou esperando o usuário. A decisão sobre comando/escrita/MCP só é
 * automática quando ele e o Jev concordam (`decideBotPending`, em shared); o resto vai
 * para o usuário como card na conversa dele. Nunca aplica nada aqui: grava a nota de
 * auditoria na fila e a API responde o card pelo mesmo caminho do clique.
 */

export const DECIDE_BOT_PENDING_TOOL_NAME = "decide_bot_pending";
/** Teto de decisões automáticas por pedido (contra laço de aprovações). */
export const BOT_PENDING_MAX_AUTO = 8;

export const DECIDE_BOT_PENDING_TOOL: ChatTool = {
	type: "function",
	function: {
		name: DECIDE_BOT_PENDING_TOOL_NAME,
		description:
			"Answer or escalate an item a bot you messaged left waiting for the user (an entry of a [pending_items] block in that bot's reply: command/write approval, connector action, questionnaire). Pass its `handle`. decision: \"approve\" or \"reject\" (approvals; give `reason` and `confidence` 0-1 based on the task you delegated and what the user asked: approve ONLY if clearly within it), \"answer\" (questionnaire; `answers` = question name -> choice value(s), ONLY when the user's own request already gives you the information), or \"escalate\" (anything you are not sure about: the card goes to the user). An independent reviewer double-checks approvals; irreversible actions (sending, deleting, paying), blocked commands and anything uncertain always go to the user, so when in doubt escalate. When it is escalated or decided, tell the user in one short sentence and end your turn.",
		parameters: {
			type: "object",
			properties: {
				handle: { type: "string", description: "The item's handle from [pending_items]" },
				decision: { type: "string", enum: ["approve", "reject", "answer", "escalate"] },
				reason: { type: "string", description: "Short reason (shown in the audit note; for reject it is sent to the bot as the comment)" },
				confidence: { type: "number", description: "0-1, how sure you are (approve/reject)" },
				answers: { type: "object", description: "Questionnaire answers: question name -> value or array of values", additionalProperties: true },
			},
			required: ["handle", "decision"],
		},
	},
};

/** Exposta quando o bot liga "Decidir pelos outros bots", há 2+ bots e existe humano na cadeia. */
export function shouldExposeDecideBotPending(input: { origin: string | undefined; botCount: number; enabled: boolean }): boolean {
	return input.enabled && input.botCount >= 2 && (input.origin === "chat" || input.origin === "bot") && !isUnattendedOrigin(input.origin);
}

const JEV_QUESTIONS = {
	within_scope: {
		instructions:
			"Is this proposed action within what the user asked and the task that was delegated (nothing beyond it, nothing the user did not ask for)? Judge only the action shown.",
		criteria: { true: "Clearly within the request", false: "Outside the request or not needed for it" },
	},
	reversible: {
		instructions: "Can this action be fully undone easily (local files under version control, a test or build, reading data), losing nothing permanent?",
		criteria: { true: "Easily reversible", false: "Hard or impossible to undo" },
	},
	harmless_outward: {
		instructions:
			"Is this action free of harmful effects outside the user's own workspace (no messages sent to other people, no payments, no publishing, no deleting of remote data, no leaking of secrets)?",
		criteria: { true: "No harmful outward effect", false: "May harm others or the outside world" },
	},
};

/** Jev julga a proposta do orquestrador. `null` = indisponível (desligado, sem chave ou falhou). */
export async function judgeWithJev(input: {
	rt: JevRuntime | undefined;
	item: BotPendingItem;
	userRequest: string;
	delegatedTask: string;
	proposal: PendingProposal;
	signal?: AbortSignal;
}): Promise<PendingJevVerdict> {
	if (jevModeFor(input.rt, "pending") !== "on") return null;
	const answers = await decideWithJev({
		rt: input.rt,
		feature: "pending",
		signal: input.signal,
		state: {
			question: "A bot asked the user to approve an action. Another assistant proposes a decision. Judge the action itself.",
			userRequest: clipForJev(input.userRequest, 1_000),
			delegatedTask: clipForJev(input.delegatedTask, 800),
			action: {
				kind: input.item.kind,
				title: clipForJev(input.item.title, 200),
				preview: clipForJev(input.item.preview ?? "", 800),
				...(input.item.reason ? { reason: clipForJev(input.item.reason, 200) } : {}),
			},
			proposal: { decision: input.proposal.decision, reason: clipForJev(input.proposal.reason, 300) },
		},
		questions: JEV_QUESTIONS,
	});
	if (!answers) return null;
	const { within_scope, reversible, harmless_outward } = answers.answers;
	if (within_scope === undefined || reversible === undefined || harmless_outward === undefined) return null;
	return { withinScope: within_scope, reversible, harmlessOutward: harmless_outward };
}

export type DecideBotPendingDeps = {
	enabled: (botId: string, userId: string) => Promise<boolean>;
	find: typeof findPendingForOrchestrator;
	attended: typeof isChainAttended;
	userRequest: typeof chainUserRequest;
	autoCount: typeof countAutoDecisions;
	queue: (conversationId: string, card: BotAutoDecisionCard) => Promise<boolean>;
	escalate: typeof escalatePendingNeed;
	judge: typeof judgeWithJev;
	botName: (botId: string) => Promise<string>;
};

const RELAY_NOTE: Record<PendingRelayReason, string> = {
	"setting-off": "A configuração 'Decidir pelos outros bots' está desligada.",
	unattended: "Não há humano nesta cadeia.",
	"not-decidable": "Este tipo de item só o usuário resolve.",
	"hard-deny": "Comando bloqueado: só o usuário decide.",
	irreversible: "Ação irreversível: só o usuário decide.",
	"jev-unavailable": "Jev indisponível.",
	"no-proposal": "Sem uma decisão clara.",
	"low-confidence": "Pouca confiança.",
	disagree: "Você e o Jev não concordaram.",
};

function clamp01(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
}

function subjectOf(need: BotNeed, item: BotPendingItem): string {
	const text = item.kind === "command" || item.kind === "write" ? (item.preview ?? item.title) : item.title;
	return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

export async function executeDecideBotPending(
	args: Record<string, unknown>,
	ctx: { userId: string | undefined; botId: string | undefined; conversationId: string | undefined; origin: string | undefined; jev?: JevRuntime; abortSignal?: AbortSignal },
	deps: Partial<DecideBotPendingDeps> = {},
): Promise<{ summary: string }> {
	const d: DecideBotPendingDeps = {
		enabled: botDecidesForOthers,
		find: findPendingForOrchestrator,
		attended: isChainAttended,
		userRequest: chainUserRequest,
		autoCount: countAutoDecisions,
		queue: queueAutoDecision,
		escalate: escalatePendingNeed,
		judge: judgeWithJev,
		botName: async (botId) => (await getBotName(botId, ctx.userId)) ?? "Bot",
		...deps,
	};
	if (!ctx.userId || ctx.userId === "default" || !ctx.botId || !ctx.conversationId) throw new Error("Sem conversa de bot neste run.");
	const handle = typeof args.handle === "string" ? args.handle.trim() : "";
	const decision = args.decision;
	if (!handle) throw new Error('Informe "handle" (do bloco [pending_items]).');
	if (decision !== "approve" && decision !== "reject" && decision !== "answer" && decision !== "escalate") {
		throw new Error('"decision" deve ser approve, reject, answer ou escalate.');
	}
	const found = await d.find({ userId: ctx.userId, orchestratorBotId: ctx.botId, handle });
	if (!found || !found.need.item) throw new Error("Item não encontrado ou já resolvido (talvez o usuário já respondeu).");
	const { message, need, botName } = found;
	const item = need.item!;
	const enabled = await d.enabled(ctx.botId, ctx.userId);
	const unattended = isUnattendedOrigin(ctx.origin) || !(await d.attended(message));
	const reason = typeof args.reason === "string" ? args.reason.replace(/\s+/g, " ").trim().slice(0, 300) : "";

	const escalate = async (why: string): Promise<{ summary: string }> => {
		await d.escalate({ message, need, botName });
		return {
			summary: JSON.stringify({ decided: false, escalated: true, note: `${why} O card foi enviado ao usuário nesta conversa. Diga a ele em uma frase o que ${botName} quer e que ele decide; termine o turno.` }),
		};
	};

	if (decision === "escalate") return escalate("Você escalou.");
	if (!enabled || unattended) return escalate(RELAY_NOTE[!enabled ? "setting-off" : "unattended"]);
	if ((await d.autoCount(ctx.conversationId, message.id)) >= BOT_PENDING_MAX_AUTO) return escalate("Muitas decisões automáticas neste pedido.");

	const decider = await d.botName(ctx.botId);
	if (item.kind === "questionnaire") {
		if (decision !== "answer") return escalate("Questionário: só responder ou escalar.");
		const outcome = decideBotQuestionnaire({ enabled, unattended, item, answers: args.answers && typeof args.answers === "object" ? (args.answers as Record<string, unknown>) : null });
		if (outcome.action === "relay") return escalate(RELAY_NOTE[outcome.why]);
		const queued = await d.queue(
			ctx.conversationId,
			buildAutoDecisionCard({ botMessageId: message.id, botId: message.toBotId, botName, deciderName: decider, decision: "answered", subject: subjectOf(need, item), reason: reason || "informação do pedido do usuário", withJev: false, need, answers: outcome.answers }),
		);
		if (!queued) return { summary: JSON.stringify({ decided: false, note: "Este item já foi decidido." }) };
		return { summary: JSON.stringify({ decided: true, applied: "answered", note: `Respondi ao ${botName} com as respostas dadas; ele segue sozinho e a resposta dele volta para você. Diga ao usuário em uma frase e termine o turno.` }) };
	}

	if (decision !== "approve" && decision !== "reject") return escalate("Para aprovações use approve, reject ou escalate.");
	const proposal: PendingProposal = { decision, reason: reason || (decision === "approve" ? "dentro do pedido" : "fora do pedido"), confidence: clamp01(args.confidence) };
	// Itens que nunca são automáticos dispensam a chamada ao Jev.
	const mayJudge = (item.kind === "command" || item.kind === "write" || item.kind === "mcp") && !item.hardDeny && !item.irreversible;
	const jev = mayJudge
		? await d.judge({ rt: ctx.jev, item, userRequest: await d.userRequest(message), delegatedTask: message.content, proposal, signal: ctx.abortSignal })
		: null;
	const outcome = decideBotPending({ enabled, unattended, item, proposal, jev });
	if (outcome.action === "relay") return escalate(RELAY_NOTE[outcome.why]);

	const approved = outcome.action === "auto-approve";
	const card = buildAutoDecisionCard({
		botMessageId: message.id,
		botId: message.toBotId,
		botName,
		deciderName: decider,
		decision: approved ? "approved" : "rejected",
		subject: subjectOf(need, item),
		reason: proposal.reason,
		withJev: true,
		need,
		...(approved ? {} : { feedback: proposal.reason }),
	});
	const queued = await d.queue(ctx.conversationId, card);
	if (!queued) return { summary: JSON.stringify({ decided: false, note: "Este item já foi decidido." }) };
	return {
		summary: JSON.stringify({
			decided: true,
			applied: approved ? "approved" : "rejected",
			note: `${autoDecisionNote(card)}. ${approved ? `${botName} segue sozinho` : `${botName} recebe a recusa com o seu motivo e se ajusta`}; o resultado volta para você. Diga ao usuário em uma frase e termine o turno.`,
		}),
	};
}
