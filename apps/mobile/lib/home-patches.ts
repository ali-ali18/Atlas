// Edições salvas por cima de uma atualização da home em voo: o servidor pode ter respondido ANTES do PATCH, então o
// resultado dessa atualização não pode desfazer o que a pessoa acabou de salvar. Cada patch ganha um número; a
// atualização marca o número no início e, ao terminar, reaplica só os patches mais novos que a marca.
import type { HomeBot, HomeSnapshot } from "./home-types";

export type BotFields = Partial<Pick<HomeBot, "name" | "color" | "shape" | "language" | "pinned" | "pinOrder" | "sectionId">>;

export class PendingBotPatches {
	private seq = 0;
	private patches: Array<{ seq: number; botId: string; patch: BotFields }> = [];
	// Bots criados no aparelho: uma atualização que começou antes da criação não os conhece e não pode apagá-los.
	private added: Array<{ seq: number; bot: HomeBot }> = [];

	add(botId: string, patch: BotFields): void {
		this.seq += 1;
		this.patches.push({ seq: this.seq, botId, patch });
	}

	/** Bot recém-criado (pelo "+" ou por um cartão do chat): sobrevive a uma atualização que já estava em voo. */
	addBot(bot: HomeBot): void {
		this.seq += 1;
		this.added = [...this.added.filter((entry) => entry.bot.id !== bot.id), { seq: this.seq, bot }];
	}

	/** Marca o início de uma atualização: patches com número maior que a marca ainda não estão no que o servidor devolve. */
	mark(): number {
		return this.seq;
	}

	/** Reaplica os patches mais novos que a marca e descarta os que a atualização já cobre. */
	applyOver(snapshot: HomeSnapshot, marker: number): HomeSnapshot {
		const newer = this.patches.filter((entry) => entry.seq > marker);
		// Patches de antes da marca já estavam salvos quando a atualização começou: o servidor os devolve.
		this.patches = newer;
		const newerAdds = this.added.filter((entry) => entry.seq > marker);
		this.added = newerAdds;
		// Bot criado depois do início da atualização e ausente na resposta: volta ao topo; se a resposta o trouxe, vale a dela.
		const known = new Set(snapshot.bots.map((bot) => bot.id));
		const missing = newerAdds.map((entry) => entry.bot).filter((bot) => !known.has(bot.id));
		const base = missing.length > 0 ? { ...snapshot, bots: [...missing, ...snapshot.bots] } : snapshot;
		if (newer.length === 0) return base;
		return { ...base, bots: base.bots.map((bot) => newer.filter((entry) => entry.botId === bot.id).reduce((current, entry) => ({ ...current, ...entry.patch }), bot)) };
	}

	clear(): void {
		this.patches = [];
		this.added = [];
	}
}
