// Fakes da porta `Bots` para teste: bots POR DONO (outro dono não lista, não recebe, não vira principal), mensagens
// enfileiradas, decisões de pendência e propostas registradas.
import { resolveTargetBot, type BotProposalEvent, type BotRosterEntry } from "@workspace/shared";
import type { BotProposals, Bots, PendingDecisionInput, PendingDecisionOutcome, SentBotMessage } from "../ports/bots.js";

export type FakeBot = BotRosterEntry & { owner: string };

export class FakeBots {
	readonly sent: Array<{ userId: string; runId: string; fromBotId: string; toBotId: string; message: string; title: string }> = [];
	readonly decisions: Array<{ userId: string; runId: string; input: PendingDecisionInput }> = [];
	readonly proposals: Array<{ userId: string; runId: string; proposal: BotProposalEvent }> = [];
	/** Próxima chamada de `send` lança com esta mensagem (ex.: teto da cadeia). */
	sendFails: string | null = null;
	/** Resultado de `decidePending` (padrão: escalado ao dono). */
	decideWith: PendingDecisionOutcome = { status: "escalated", botName: "Ana", why: "the owner decides approvals" };
	accountSkills: string[] = ["resumo-diario"];

	readonly port: Bots;

	constructor(
		readonly bots: FakeBot[],
		readonly selfId: string,
		options: { decide?: boolean; proposals?: boolean } = {},
	) {
		this.port = this.buildPort(options);
	}

	private ownedBy(userId: string): FakeBot[] {
		return this.bots.filter((bot) => bot.owner === userId);
	}

	private buildPort(options: { decide?: boolean; proposals?: boolean }): Bots {
		return {
		selfId: this.selfId,
		roster: async (userId) => this.ownedBy(userId).map(({ owner: _owner, ...entry }) => entry),
		send: async (userId, runId, input): Promise<SentBotMessage> => {
			if (this.sendFails) throw new Error(this.sendFails);
			const roster = this.ownedBy(userId);
			const resolved = resolveTargetBot(input.bot, roster, this.selfId);
			if (!resolved.ok) throw new Error(resolved.error);
			const id = `msg-${this.sent.length + 1}`;
			this.sent.push({ userId, runId, fromBotId: this.selfId, toBotId: resolved.bot.id, message: input.message, title: input.title });
			return { id, targetId: resolved.bot.id, targetName: resolved.bot.name };
		},
		setPrimary: async (userId, botId) => {
			const bot = this.ownedBy(userId).find((entry) => entry.id === botId);
			if (!bot) return false;
			for (const entry of this.ownedBy(userId)) entry.isPrimary = entry.id === botId;
			return true;
		},
		...(options.decide !== false && {
			decidePending: async (userId: string, runId: string, input: PendingDecisionInput) => {
				this.decisions.push({ userId, runId, input });
				return this.decideWith;
			},
		}),
		...(options.proposals !== false && {
			proposals: {
				show: async (userId, runId, proposal) => {
					this.proposals.push({ userId, runId, proposal });
				},
				skillNames: async () => this.accountSkills,
			} satisfies BotProposals,
		}),
		};
	}
}
