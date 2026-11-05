// Quem está trabalhando / esperando o usuário AGORA, pelos avisos `run` do canal de eventos (`botId` + `status`).
// Complementa o retrato da home (`working` do servidor): o aviso chega antes do refresh e cobre o run pausado
// (`waiting_user`), que o servidor não conta como "trabalhando". `ready`/`resync` limpam (o refresh refaz o retrato).
import { isActiveRunStatus, isParkedRunStatus, isTerminalRunStatus, type HubEvent } from "./event-hub";

export type BotRunSets = { active: ReadonlySet<string>; waiting: ReadonlySet<string> };

export const EMPTY_RUN_SETS: BotRunSets = { active: new Set(), waiting: new Set() };

/** Aplica um evento; devolve o MESMO objeto quando nada mudou (barato para `useSyncExternalStore`). */
export function applyRunEvent(sets: BotRunSets, event: HubEvent): BotRunSets {
	if (event.type !== "run") return sets;
	const botId = typeof event.payload.botId === "string" && event.payload.botId ? event.payload.botId : null;
	const status = typeof event.payload.status === "string" ? event.payload.status : null;
	if (!botId || !status) return sets;
	const wantActive = isActiveRunStatus(status);
	const wantWaiting = isParkedRunStatus(status);
	if (!wantActive && !wantWaiting && !isTerminalRunStatus(status)) return sets;
	if (sets.active.has(botId) === wantActive && sets.waiting.has(botId) === wantWaiting) return sets;
	const active = new Set(sets.active);
	const waiting = new Set(sets.waiting);
	if (wantActive) active.add(botId);
	else active.delete(botId);
	if (wantWaiting) waiting.add(botId);
	else waiting.delete(botId);
	return { active, waiting };
}

type Listener = () => void;

/** Estado de módulo (um por app): o provider da home liga ao hub; as linhas leem por `useSyncExternalStore`. */
let current: BotRunSets = EMPTY_RUN_SETS;
const listeners = new Set<Listener>();

export const botRunStore = {
	get: (): BotRunSets => current,
	subscribe(listener: Listener): () => void {
		listeners.add(listener);
		return () => void listeners.delete(listener);
	},
	apply(event: HubEvent): void {
		const next = applyRunEvent(current, event);
		if (next === current) return;
		current = next;
		for (const listener of [...listeners]) listener();
	},
	reset(): void {
		if (current === EMPTY_RUN_SETS) return;
		current = EMPTY_RUN_SETS;
		for (const listener of [...listeners]) listener();
	},
};
