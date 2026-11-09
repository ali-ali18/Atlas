// Porta `Bots` do v4 no worker (F9): falar com os outros bots do MESMO dono, escolher o bot principal, responder (ou
// escalar) pendências que outro bot deixou e propor um bot novo. Montado POR RUN: o bot, a conversa e o `emit` vêm do run,
// nunca de argumento do modelo; toda chamada do db recebe o `userId` do RUN, então bot, mensagem e pendência de outro dono
// são indistinguíveis de inexistentes (40-seguranca). NÃO importa o agent-runtime: a lógica de entrega, cadeia e tetos já
// mora em `@workspace/db` (`sendBotMessage`) e a matriz de decisão em `@workspace/shared`.
//
// Contra laço bot<->bot (estrutural, no db, igual ao legado): no máximo `BOT_MESSAGE_MAX_DEPTH` saltos por cadeia,
// `BOT_CHAIN_MAX_MESSAGES` mensagens por cadeia e `BOT_RUN_MAX_SENDS` envios por run; o bot não manda para si mesmo.
//
// A resposta do outro bot NÃO passa por aqui: o varredor de mensagens entre bots (`bot-messages.ts`) a grava na conversa
// do remetente e acorda um run novo. No v4 essa fala entra no histórico como DADO NÃO CONFIÁVEL (`buildV4History`,
// origem `bot`), nunca como fala do dono.
import type { BotProposals, Bots, PendingDecisionInput, PendingDecisionOutcome } from "@workspace/agent";
import {
	botDecidesForOthers,
	countAutoDecisions,
	escalatePendingNeed,
	findPendingForOrchestrator,
	getBotName,
	isChainAttended,
	listSkillDocs,
	listUserBotRoster,
	persistConversationCardFromEvent,
	queueAutoDecision,
	sendBotMessage,
	setPrimaryBot,
} from "@workspace/db";
import {
	buildAutoDecisionCard,
	decideBotPending,
	decideBotQuestionnaire,
	type BotPendingItem,
	type ComputerUseEvent,
	type PendingRelayReason,
} from "@workspace/shared";

/** Teto de decisões automáticas por pedido (contra laço de aprovações), o mesmo do legado. */
export const BOT_PENDING_MAX_AUTO = 8;

export type V4BotsDeps = {
	roster: typeof listUserBotRoster;
	send: typeof sendBotMessage;
	setPrimary: typeof setPrimaryBot;
	/** "Decidir pelos outros bots" está ligado neste bot? */
	decidesForOthers: typeof botDecidesForOthers;
	findPending: typeof findPendingForOrchestrator;
	attended: typeof isChainAttended;
	autoCount: typeof countAutoDecisions;
	queueAuto: typeof queueAutoDecision;
	escalate: typeof escalatePendingNeed;
	botName: typeof getBotName;
	listSkills: typeof listSkillDocs;
	persistCard: (conversationId: string, event: ComputerUseEvent) => Promise<void>;
};

export const realV4BotsDeps: V4BotsDeps = {
	roster: listUserBotRoster,
	send: sendBotMessage,
	setPrimary: setPrimaryBot,
	decidesForOthers: botDecidesForOthers,
	findPending: findPendingForOrchestrator,
	attended: isChainAttended,
	autoCount: countAutoDecisions,
	queueAuto: queueAutoDecision,
	escalate: escalatePendingNeed,
	botName: getBotName,
	listSkills: listSkillDocs,
	persistCard: (conversationId, event) => persistConversationCardFromEvent(conversationId, event),
};

export type V4BotsScope = {
	botId: string;
	conversationId?: string | null;
	emit: (event: ComputerUseEvent) => void | Promise<void>;
	log?: (message: string) => void;
	/** O dono ligou "Decidir pelos outros bots" (lido na montagem; sem isso `decidePending` nem existe). */
	decideEnabled?: boolean;
};

/** Por que o item foi ao dono (texto para o MODELO, inglês). */
const RELAY_NOTE: Readonly<Record<PendingRelayReason, string>> = {
	"setting-off": "the setting to decide for other bots is off",
	unattended: "no person is in this chain",
	"not-decidable": "only the owner resolves this kind of item",
	"hard-deny": "blocked command: only the owner decides",
	irreversible: "irreversible action: only the owner decides",
	"jev-unavailable": "approvals are always the owner's call in this version",
	"no-proposal": "no clear answer was given",
	"low-confidence": "low confidence",
	disagree: "no second opinion agreed",
};

function subjectOf(item: BotPendingItem): string {
	const text = item.kind === "command" || item.kind === "write" ? (item.preview ?? item.title) : item.title;
	return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

export async function isBotDecideEnabled(botId: string, userId: string, deps: Pick<V4BotsDeps, "decidesForOthers"> = realV4BotsDeps): Promise<boolean> {
	try {
		return await deps.decidesForOthers(botId, userId);
	} catch {
		return false;
	}
}

export function createV4Bots(input: { scope: V4BotsScope; deps?: V4BotsDeps }): Bots {
	const deps = input.deps ?? realV4BotsDeps;
	const { scope } = input;
	const log = scope.log ?? ((message: string) => console.warn(message));

	const proposals: BotProposals = {
		async show(_userId, _runId, proposal) {
			if (scope.conversationId) {
				await deps.persistCard(scope.conversationId, proposal).catch((error: unknown) => {
					log(`[engine-v4] cartão "bot-proposal" não gravado na conversa: ${(error instanceof Error ? error.message : "erro").slice(0, 200)}`);
				});
			}
			await scope.emit(proposal);
		},
		async skillNames(userId) {
			const docs = await deps.listSkills(userId);
			// Só habilidades da CONTA (sem bot), ativas e ligadas, como no legado.
			return docs.filter((doc) => doc.botId === null && doc.enabled && doc.status === "active").map((doc) => doc.name);
		},
	};

	async function decidePending(userId: string, _runId: string, decision: PendingDecisionInput): Promise<PendingDecisionOutcome> {
		if (!scope.conversationId) throw new Error("There is no bot conversation in this run, so nothing was decided.");
		const found = await deps.findPending({ userId, orchestratorBotId: scope.botId, handle: decision.handle });
		if (!found || !found.need.item) throw new Error("Item not found or already resolved (maybe the owner answered first).");
		const { message, need, botName } = found;
		const item: BotPendingItem = found.need.item;
		const escalate = async (why: string): Promise<PendingDecisionOutcome> => {
			await deps.escalate({ message, need, botName });
			return { status: "escalated", botName, why };
		};
		if (decision.decision === "escalate") return escalate("you passed it on");
		const enabled = await deps.decidesForOthers(scope.botId, userId);
		const unattended = !(await deps.attended(message));
		if (!enabled) return escalate(RELAY_NOTE["setting-off"]);
		if (unattended) return escalate(RELAY_NOTE.unattended);
		if ((await deps.autoCount(scope.conversationId, message.id)) >= BOT_PENDING_MAX_AUTO) return escalate("too many automatic decisions for this request");

		const decider = (await deps.botName(scope.botId, userId)) ?? "Bot";
		const reason = (decision.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
		if (item.kind === "questionnaire") {
			if (decision.decision !== "answer") return escalate("questionnaires are answered or passed on, not approved");
			const outcome = decideBotQuestionnaire({ enabled, unattended: false, item, answers: decision.answers ?? null });
			if (outcome.action === "relay") return escalate(RELAY_NOTE[outcome.why]);
			const queued = await deps.queueAuto(
				scope.conversationId,
				buildAutoDecisionCard({ botMessageId: message.id, botId: message.toBotId, botName, deciderName: decider, decision: "answered", subject: subjectOf(item), reason: reason || "informação do pedido do dono", withJev: false, need, answers: outcome.answers }),
			);
			return queued ? { status: "answered", botName } : { status: "already_decided", botName };
		}

		// Aprovação (comando, escrita, conector): sem o revisor independente (Jev) no v4, a matriz sempre devolve "relay" e o
		// dono decide no cartão. Passa pela mesma função do legado para que bloqueios e ações irreversíveis sigam explicados.
		if (decision.decision !== "approve" && decision.decision !== "reject") return escalate("approvals use approve, reject or escalate");
		const outcome = decideBotPending({ enabled, unattended: false, item, proposal: { decision: decision.decision, reason: reason || "sem motivo", confidence: decision.confidence ?? 0 }, jev: null });
		if (outcome.action === "relay") return escalate(RELAY_NOTE[outcome.why]);
		// Inalcançável sem Jev (`jev: null` sempre relaya); falha fechada se a matriz mudar: o dono decide.
		return escalate(RELAY_NOTE["jev-unavailable"]);
	}

	return {
		selfId: scope.botId,
		roster: (userId) => deps.roster(userId),
		async send(userId, runId, message) {
			const sent = await deps.send({ userId, fromBotId: scope.botId, fromRunId: runId, bot: message.bot, message: message.message, title: message.title });
			return { id: sent.id, targetId: sent.targetId, targetName: sent.targetName };
		},
		setPrimary: (userId, botId) => deps.setPrimary(userId, botId, true),
		...(scope.decideEnabled === true && { decidePending }),
		proposals,
	};
}
