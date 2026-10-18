"use client";

import { useSyncExternalStore } from "react";

import { listActiveWork, type ActiveWorkItemResponse } from "@/lib/atlas-api";
import { currentPollMode, getSharedEventHub, shouldPollTick } from "@/lib/event-hub-client";

/** Sessões de código e subagentes em andamento (todas as conversas), com "visto por último". */

export type ActiveWorkRowState = "working" | "waiting" | "done" | "error";

export type ActiveWorkRow = {
	key: string;
	item: ActiveWorkItemResponse;
	title: string;
	/** Nome da conversa (bot) a que o trabalho pertence. */
	conversation: string;
	state: ActiveWorkRowState;
	startedAt: number;
	awaitingApproval: boolean;
	/** Terminou depois da última vez que o usuário olhou. */
	unread: boolean;
};

const WORKING: readonly string[] = ["CREATING", "QUEUED", "RUNNING"];

function repoLabel(repo: string | null, branch: string | null): string {
	const name = repo?.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
	if (name && branch) return `${name} · ${branch}`;
	return name || branch || "Sessão de código";
}

/** Linhas ordenadas: trabalhando primeiro (mais novo antes), depois as terminadas não vistas. */
export function buildActiveRows(items: readonly ActiveWorkItemResponse[], seen: Readonly<Record<string, number>>): { rows: ActiveWorkRow[]; running: number; unread: number } {
	const rows: ActiveWorkRow[] = [];
	for (const item of items) {
		const startedAt = Date.parse(item.startedAt);
		if (item.kind === "subagent") {
			rows.push({
				key: `subagent:${item.id}`,
				item,
				title: item.title || "Subagente",
				conversation: item.conversationTitle ?? "Conversa",
				state: item.awaitingApproval ? "waiting" : "working",
				startedAt: Number.isFinite(startedAt) ? startedAt : 0,
				awaitingApproval: item.awaitingApproval,
				unread: false,
			});
			continue;
		}
		const working = WORKING.includes(item.status);
		const finishedAt = Date.parse(item.lastActiveAt);
		const unread = !working && Number.isFinite(finishedAt) && finishedAt > (seen[item.id] ?? 0);
		// Terminada e já vista: sai da lista.
		if (!working && !unread) continue;
		rows.push({
			key: `dev:${item.id}`,
			item,
			title: repoLabel(item.repo, item.branch),
			conversation: item.conversationTitle ?? "Conversa",
			state: item.status === "ERROR" ? "error" : working ? (item.awaitingApproval ? "waiting" : "working") : "done",
			startedAt: Number.isFinite(startedAt) ? startedAt : 0,
			awaitingApproval: item.awaitingApproval,
			unread,
		});
	}
	rows.sort((a, b) => Number(b.state === "working" || b.state === "waiting") - Number(a.state === "working" || a.state === "waiting") || b.startedAt - a.startedAt);
	return {
		rows,
		running: rows.filter((row) => row.state === "working" || row.state === "waiting").length,
		unread: rows.filter((row) => row.unread).length,
	};
}

const SEEN_KEY = "dev-active-work-seen";

function readSeen(): Record<string, number> {
	try {
		const raw = window.localStorage.getItem(SEEN_KEY);
		const parsed = raw ? (JSON.parse(raw) as unknown) : {};
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, number>) : {};
	} catch {
		return {};
	}
}

type State = { items: readonly ActiveWorkItemResponse[]; seen: Record<string, number>; loaded: boolean };
let state: State = { items: [], seen: {}, loaded: false };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
/** Pré-visualização: a lista fixa não é sobrescrita pela consulta. */
let frozen = false;

function set(next: Partial<State>) {
	state = { ...state, ...next };
	for (const listener of listeners) listener();
}

/** Marca como visto (some o ponto de "terminou"). */
export function markActiveWorkSeen(id: string) {
	const seen = { ...state.seen, [id]: Date.now() };
	set({ seen });
	try {
		window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
	} catch {
		// armazenamento indisponível: vale só nesta aba
	}
}

/** Define a lista direto (pré-visualização e testes). */
export function setActiveWorkItems(items: readonly ActiveWorkItemResponse[], options: { freeze?: boolean } = {}) {
	if (options.freeze) frozen = true;
	set({ items, loaded: true });
}

async function refresh() {
	if (frozen || inFlight || typeof document === "undefined" || document.visibilityState === "hidden") return;
	inFlight = true;
	try {
		set({ items: await listActiveWork(), loaded: true });
	} catch {
		// mantém a lista anterior; a próxima volta tenta de novo
	} finally {
		inFlight = false;
	}
}

const POLL_MS = 5000;
/** Eventos do hub que mudam a lista "Em andamento" (run, sessão de código, job, leitura). */
const HUB_TYPES = new Set(["run", "run-activity", "dev-session", "dev-job", "read", "message"]);
const HUB_REFRESH_DEBOUNCE_MS = 300;

let hubOff: (() => void) | null = null;
let hubTimer: ReturnType<typeof setTimeout> | null = null;
let lastRefreshAt = 0;

async function refreshTracked() {
	lastRefreshAt = Date.now();
	await refresh();
}

/** Com o hub conectado a lista só se atualiza por evento; sem ele, a consulta antiga de 5 s; hub fora do ar, uma de segurança lenta. */
function tick() {
	if (shouldPollTick(currentPollMode(), Date.now(), lastRefreshAt)) void refreshTracked();
}

function attachHub() {
	const hub = getSharedEventHub();
	if (!hub) return;
	const refreshSoon = () => {
		if (hubTimer !== null) return;
		hubTimer = setTimeout(() => {
			hubTimer = null;
			void refreshTracked();
		}, HUB_REFRESH_DEBOUNCE_MS);
	};
	const offEvents = hub.subscribe((event) => {
		if (HUB_TYPES.has(event.type)) refreshSoon();
	});
	const offResync = hub.onResync(refreshSoon);
	hubOff = () => {
		offEvents();
		offResync();
		if (hubTimer !== null) clearTimeout(hubTimer);
		hubTimer = null;
	};
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	if (listeners.size === 1) {
		set({ seen: readSeen() });
		void refreshTracked();
		attachHub();
		timer = setInterval(tick, POLL_MS);
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			if (timer !== null) clearInterval(timer);
			timer = null;
			hubOff?.();
			hubOff = null;
		}
	};
}

const EMPTY: State = { items: [], seen: {}, loaded: false };

/** Assina a lista "Em andamento" (por evento do hub; sem hub, consulta a cada 5 s enquanto houver quem use). */
export function useActiveWork(): { rows: ActiveWorkRow[]; running: number; unread: number; loaded: boolean } {
	const current = useSyncExternalStore(
		subscribe,
		() => state,
		() => EMPTY,
	);
	return { ...buildActiveRows(current.items, current.seen), loaded: current.loaded };
}
