// Edições salvas por cima de uma atualização da home em voo: o servidor pode ter respondido ANTES do PATCH, então o
// resultado dessa atualização não pode desfazer o que a pessoa acabou de salvar. Cada patch ganha um número; a
// atualização marca o número no início e, ao terminar, reaplica só os patches mais novos que a marca.
import type { HomeBot, HomeSnapshot } from "./home-types";

export type BotFields = Partial<Pick<HomeBot, "name" | "color" | "shape" | "language">>;

export class PendingBotPatches {
	private seq = 0;
	private patches: Array<{ seq: number; botId: string; patch: BotFields }> = [];

	add(botId: string, patch: BotFields): void {
		this.seq += 1;
		this.patches.push({ seq: this.seq, botId, patch });
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
		if (newer.length === 0) return snapshot;
		return { ...snapshot, bots: snapshot.bots.map((bot) => newer.filter((entry) => entry.botId === bot.id).reduce((current, entry) => ({ ...current, ...entry.patch }), bot)) };
	}

	clear(): void {
		this.patches = [];
	}
}
