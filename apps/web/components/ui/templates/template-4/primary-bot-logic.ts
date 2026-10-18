import type { Agent } from "./data";

const INTRO_KEY_PREFIX = "atlas:primary-bot-intro-dismissed:";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function primaryIntroKey(userId: string | null | undefined): string {
	return `${INTRO_KEY_PREFIX}${userId || "anon"}`;
}

/** localStorage pode lançar (janela privada, dados bloqueados): nesse caso trata como "não dispensado". */
export function readPrimaryIntroDismissed(storage: StorageLike | null, key: string): boolean {
	try {
		return storage?.getItem(key) === "1";
	} catch {
		return false;
	}
}

export function writePrimaryIntroDismissed(storage: StorageLike | null, key: string): void {
	try {
		storage?.setItem(key, "1");
	} catch {
		// sem storage: o aviso pode voltar na próxima carga, sem prejuízo.
	}
}

/** Bots de verdade (grupos não contam). */
export function soloBots(agents: Agent[]): Agent[] {
	return agents.filter((agent) => !agent.members?.length);
}

/** O modal de apresentação aparece uma vez: 2+ bots, nenhum principal, ainda não dispensado. */
export function shouldShowPrimaryIntro(input: {
	agents: Agent[];
	loading: boolean;
	dismissed: boolean;
	busy?: boolean;
}): boolean {
	if (input.loading || input.dismissed || input.busy) return false;
	const bots = soloBots(input.agents);
	return bots.length >= 2 && !bots.some((agent) => agent.isPrimary);
}

/** Lista do seletor: bots simples, sem o principal atual, filtrados pela busca. */
export function pickablePrimaryBots(agents: Agent[], query = ""): Agent[] {
	const term = query.trim().toLocaleLowerCase();
	return soloBots(agents).filter(
		(agent) => !agent.isPrimary && (!term || agent.name.toLocaleLowerCase().includes(term)),
	);
}
