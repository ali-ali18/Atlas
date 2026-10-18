"use client";

import { isDevSessionEvent, type DevSessionEvent, type DevTimingEvent, type SubagentTaskView } from "@workspace/shared";
import { useSyncExternalStore } from "react";

import {
	applyContextCompacted,
	applyDevHistory,
	applyDevSessionEvent,
	hydrateDevSession,
	withRunActivity,
	type ContextCompactedValue,
	type ContextUsageValue,
	applyContextUsage,
	applyDevTiming,
	type DevEventMeta,
	type DevHistoryItem,
	type DevSessionApiSummary,
	type DevSessionMap,
	type DevSessionView,
} from "./reducer";
import {
	applySubagentTrack,
	subagentKey,
	type SubagentTrack,
	type SubagentTrackEvent,
	type SubagentTrackMap,
} from "./subagent-track";

/** O que a 3ª coluna mostra no lugar das configurações (ou nada). */
export type ActivitySelection =
	| { kind: "dev"; sessionId: string }
	| { kind: "subagent"; groupId: string; taskIndex: number }
	| null;

type State = {
	sessions: DevSessionMap;
	tracks: SubagentTrackMap;
	subagentTasks: Readonly<Record<string, readonly SubagentTaskView[]>>;
	selection: ActivitySelection;
	/** Runs do agente em andamento nesta aba (alimentado pelo chat). */
	liveRuns: ReadonlySet<string>;
};

/** Quando cada run começou (ms): o relógio do cartão conta do início do run atual. */
const runStarts = new Map<string, number>();
let state: State = { sessions: {}, tracks: {}, subagentTasks: {}, selection: null, liveRuns: new Set() };
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
	state = { ...state, ...next };
	// "Trabalhando" depende do run ativo, não só do status do container.
	const sessions = withRunActivity(state.sessions, state.liveRuns, Date.now(), runStarts);
	if (sessions !== state.sessions) state = { ...state, sessions };
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Zera tudo (troca de conta/testes). */
export function resetDevSessionStore() {
	runStarts.clear();
	set({ sessions: {}, tracks: {}, subagentTasks: {}, selection: null, liveRuns: new Set() });
}

/** O chat começou a acompanhar um run (enviado aqui ou retomado/descoberto). */
export function markRunLive(runId: string, startedAt?: number) {
	const known = runStarts.get(runId);
	const at = startedAt !== undefined && Number.isFinite(startedAt) ? startedAt : Date.now();
	if (known === undefined || at < known) runStarts.set(runId, at);
	if (state.liveRuns.has(runId)) {
		if (startedAt !== undefined) set({});
		return;
	}
	set({ liveRuns: new Set(state.liveRuns).add(runId) });
}

/** O run terminou (ou o chat parou de acompanhar): sessões sem outro run viram "Pronta". */
export function markRunEnded(runId: string) {
	if (!state.liveRuns.has(runId)) return;
	const liveRuns = new Set(state.liveRuns);
	liveRuns.delete(runId);
	set({ liveRuns });
}

export function ingestDevSessionEvent(event: DevSessionEvent, meta?: Partial<DevEventMeta>) {
	const next = applyDevSessionEvent(state.sessions, event, { at: meta?.at ?? Date.now(), ...meta });
	if (next !== state.sessions) set({ sessions: next });
}

export function ingestRunEvent(event: { type?: unknown }, meta?: Partial<DevEventMeta>) {
	if (isDevSessionEvent(event)) ingestDevSessionEvent(event, meta);
}

export function hydrateDevSessionFromApi(api: DevSessionApiSummary, options?: { authoritativeStatus?: boolean }) {
	set({ sessions: hydrateDevSession(state.sessions, api, options) });
}

export function ingestContextUsage(event: ContextUsageValue, meta?: Partial<DevEventMeta>) {
	const next = applyContextUsage(state.sessions, event, { at: meta?.at ?? Date.now(), ...meta });
	if (next !== state.sessions) set({ sessions: next });
}

export function ingestDevTiming(event: DevTimingEvent, meta?: Partial<DevEventMeta>) {
	const next = applyDevTiming(state.sessions, event, { at: meta?.at ?? Date.now(), ...meta });
	if (next !== state.sessions) set({ sessions: next });
}

export function ingestContextCompacted(event: ContextCompactedValue, meta?: Partial<DevEventMeta>) {
	const next = applyContextCompacted(state.sessions, event, { at: meta?.at ?? Date.now(), ...meta });
	if (next !== state.sessions) set({ sessions: next });
}

/** Painel após recarregar: reaplica comandos, diffs e tarefas persistidos. */
export function hydrateDevSessionHistory(history: readonly DevHistoryItem[]) {
	const next = applyDevHistory(state.sessions, history);
	if (next !== state.sessions) set({ sessions: next });
}

export function recordSubagentEvent(event: SubagentTrackEvent, at = Date.now()) {
	const next = applySubagentTrack(state.tracks, event, at);
	if (next !== state.tracks) set({ tracks: next });
}

/** O cartão renderizado registra suas tarefas para a coluna 3 mostrar a mesma versão. */
export function registerSubagentTasks(groupId: string, tasks: readonly SubagentTaskView[]) {
	const current = state.subagentTasks[groupId];
	if (current && current.length === tasks.length && current.every((task, i) => task === tasks[i])) return;
	set({ subagentTasks: { ...state.subagentTasks, [groupId]: tasks } });
}

export function openActivity(selection: NonNullable<ActivitySelection>) {
	set({ selection });
}

export function closeActivity() {
	if (state.selection !== null) set({ selection: null });
}

export function getDevSessionSnapshot(): State {
	return state;
}

function useStore<T>(select: (current: State) => T): T {
	return useSyncExternalStore(
		subscribe,
		() => select(state),
		() => select(state),
	);
}

export function useDevSession(id: string): DevSessionView | undefined {
	return useStore((current) => current.sessions[id]);
}

export function useActivitySelection(): ActivitySelection {
	return useStore((current) => current.selection);
}

export function useSubagentTrack(groupId: string, taskIndex: number): SubagentTrack | undefined {
	return useStore((current) => current.tracks[subagentKey(groupId, taskIndex)]);
}

const EMPTY_TASKS: readonly SubagentTaskView[] = [];
export function useSubagentTasks(groupId: string): readonly SubagentTaskView[] {
	return useStore((current) => current.subagentTasks[groupId] ?? EMPTY_TASKS);
}

/* Relógio compartilhado: um único intervalo de 1 s para todos os cartões. */
let clockNow = Date.now();
let clockTimer: ReturnType<typeof setInterval> | null = null;
const clockListeners = new Set<() => void>();

function subscribeClock(listener: () => void) {
	clockListeners.add(listener);
	if (clockTimer === null) {
		clockNow = Date.now();
		clockTimer = setInterval(() => {
			clockNow = Date.now();
			for (const fn of clockListeners) fn();
		}, 1000);
	}
	return () => {
		clockListeners.delete(listener);
		if (clockListeners.size === 0 && clockTimer !== null) {
			clearInterval(clockTimer);
			clockTimer = null;
		}
	};
}

const subscribeNever = () => () => {};

/** Hora atual em ms, atualizada a cada segundo só enquanto `enabled` (cartões parados não assinam). */
export function useNow(enabled: boolean): number {
	return useSyncExternalStore(
		enabled ? subscribeClock : subscribeNever,
		() => (enabled ? clockNow : 0),
		() => 0,
	);
}

/** Número de assinantes do relógio (para testes). */
export function clockSubscriberCount(): number {
	return clockListeners.size;
}
