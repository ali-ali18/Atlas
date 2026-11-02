import type { RoutineGroupRecord, RoutineRecord } from "@workspace/shared";
import * as React from "react";
import type { ApiFetch } from "./home-sync";
import { listRoutines, routinesErrorText, setRoutineEnabled } from "./routines-api";

// Estado das rotinas por bot, compartilhado entre a lista e os detalhes (pausar numa tela aparece na outra). Sem cache
// no disco: as rotinas são buscadas ao abrir. Pausar/retomar muda na hora e volta atrás se o servidor recusar.

export type RoutinesState = { routines: RoutineRecord[]; groups: RoutineGroupRecord[]; loading: boolean; loaded: boolean; error: string | null; busy: ReadonlySet<string> };

const EMPTY: RoutinesState = { routines: [], groups: [], loading: false, loaded: false, error: null, busy: new Set() };

export class RoutinesStore {
	private state = new Map<string, RoutinesState>();
	private listeners = new Set<() => void>();
	/** Contador por bot: só a resposta do `load` mais novo vale (a mais lenta não sobrescreve nem apaga o spinner do outro). */
	private generation = new Map<string, number>();
	/** Muda no `reset` (troca de conta/servidor): respostas de antes dele são ignoradas. */
	private epoch = 0;

	get = (botId: string): RoutinesState => this.state.get(botId) ?? EMPTY;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	private set(botId: string, patch: Partial<RoutinesState>): void {
		this.state.set(botId, { ...this.get(botId), ...patch });
		for (const listener of this.listeners) listener();
	}

	async load(apiFetch: ApiFetch, botId: string): Promise<void> {
		const mine = (this.generation.get(botId) ?? 0) + 1;
		this.generation.set(botId, mine);
		const epoch = this.epoch;
		const stale = () => epoch !== this.epoch || this.generation.get(botId) !== mine;
		this.set(botId, { loading: true, error: null });
		try {
			const { routines, groups } = await listRoutines(apiFetch, botId);
			if (stale()) return;
			// Pausar/retomar em voo: o que a pessoa acabou de tocar vale mais que a resposta, que pode ser anterior ao PATCH.
			const current = this.get(botId);
			const merged = routines.map((routine) => (current.busy.has(routine.id) ? (current.routines.find((item) => item.id === routine.id) ?? routine) : routine));
			this.set(botId, { routines: merged, groups, loading: false, loaded: true });
		} catch (error) {
			if (stale()) return;
			this.set(botId, { loading: false, error: routinesErrorText(error, "load") });
		}
	}

	async toggle(apiFetch: ApiFetch, botId: string, routineId: string, enabled: boolean): Promise<void> {
		const current = this.get(botId);
		if (current.busy.has(routineId)) return;
		const before = current.routines.find((routine) => routine.id === routineId);
		if (!before) return;
		const epoch = this.epoch;
		const apply = (value: boolean) => this.get(botId).routines.map((routine) => (routine.id === routineId ? { ...routine, enabled: value } : routine));
		this.set(botId, { routines: apply(enabled), busy: new Set(current.busy).add(routineId), error: null });
		try {
			await setRoutineEnabled(apiFetch, botId, routineId, enabled);
		} catch (error) {
			if (epoch === this.epoch) this.set(botId, { routines: apply(before.enabled), error: routinesErrorText(error, enabled ? "resume" : "pause") });
		} finally {
			if (epoch === this.epoch) {
				const busy = new Set(this.get(botId).busy);
				busy.delete(routineId);
				this.set(botId, { busy });
			}
		}
	}

	clearError(botId: string): void {
		this.set(botId, { error: null });
	}

	/** Troca de conta/servidor: nada do dono anterior fica. */
	reset(): void {
		this.epoch += 1;
		this.generation.clear();
		this.state.clear();
		for (const listener of this.listeners) listener();
	}
}

export const routinesStore = new RoutinesStore();

/** Estado das rotinas do bot; carrega ao abrir (e de novo quando `botId` muda). */
export function useRoutines(apiFetch: ApiFetch, botId: string): RoutinesState & { reload: () => void; toggle: (routineId: string, enabled: boolean) => void } {
	const state = React.useSyncExternalStore(routinesStore.subscribe, () => routinesStore.get(botId));
	React.useEffect(() => {
		void routinesStore.load(apiFetch, botId);
	}, [apiFetch, botId]);
	// Sair da tela leva o aviso junto: o erro de pausar não reaparece "fora de contexto" na tela anterior.
	React.useEffect(() => () => routinesStore.clearError(botId), [botId]);
	return {
		...state,
		reload: () => void routinesStore.load(apiFetch, botId),
		toggle: (routineId, enabled) => void routinesStore.toggle(apiFetch, botId, routineId, enabled),
	};
}
