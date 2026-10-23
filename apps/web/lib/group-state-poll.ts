import { shouldPollTick, type HubPollMode } from "./event-hub-client";

/** Grupo com alguém roteando/respondendo: o indicador "Bia está respondendo…" precisa desse ritmo. */
export const GROUP_STATE_BUSY_MS = 1500;
/** Depois de um envio ao grupo, o tempo em que a consulta segue no ritmo curto esperando o servidor rotear. */
export const GROUP_SEND_BUSY_HINT_MS = 15_000;
/** Teto do recuo quando o grupo está parado (sem hub). */
export const GROUP_STATE_IDLE_MAX_MS = 30_000;

/** Espera entre consultas com o grupo parado: dobra a cada consulta sem novidade, até o teto. */
export function groupStateIdleDelay(idleStreak: number): number {
	return Math.min(GROUP_STATE_BUSY_MS * 2 ** Math.max(0, idleStreak), GROUP_STATE_IDLE_MAX_MS);
}

/**
 * O tick de consulta do estado do grupo deve rodar? Ocupado (ou envio local): sempre, no ritmo curto. Parado:
 * com o hub conectado não consulta (os eventos da conversa disparam a consulta); com o hub caindo, só a
 * consulta de segurança lenta; sem hub, recua até `GROUP_STATE_IDLE_MAX_MS`.
 */
export function groupStatePollDue({
	mode,
	busy,
	now,
	lastRunAt,
	idleStreak,
}: {
	mode: HubPollMode;
	busy: boolean;
	now: number;
	lastRunAt: number;
	idleStreak: number;
}): boolean {
	if (busy) return true;
	if (mode !== "legacy") return shouldPollTick(mode, now, lastRunAt);
	return now - lastRunAt >= groupStateIdleDelay(idleStreak);
}
