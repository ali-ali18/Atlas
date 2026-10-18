import type { DevCiSummary, DevPrState, DevSessionStatusValue } from "@workspace/shared";

import { refreshDevSessionCi } from "@/lib/atlas-api";

import { getDevSessionSnapshot, ingestDevSessionEvent } from "./store";

/**
 * Atualização dos checks do PR sem gastar tokens do agente: enquanto há checks
 * pendentes o painel pergunta ao servidor (que consulta o GitHub) em intervalos
 * crescentes, por no máximo 30 min, e para quando a sessão para.
 */

export const CI_POLL_DELAYS_MS = [8_000, 12_000, 20_000, 30_000, 45_000, 60_000] as const;
export const CI_POLL_MAX_MS = 30 * 60_000;
/** Sem checks logo após abrir o PR: o GitHub pode demorar a registrá-los; tenta algumas vezes antes de desistir. */
export const CI_POLL_NONE_ATTEMPTS = 6;
const MAX_CONSECUTIVE_FAILURES = 5;

/** Espera antes da tentativa `attempt` (0 = primeira): cresce e estabiliza em 60 s. */
export function ciPollDelay(attempt: number): number {
	return CI_POLL_DELAYS_MS[Math.min(Math.max(0, attempt), CI_POLL_DELAYS_MS.length - 1)]!;
}

type PollView = {
	status: DevSessionStatusValue;
	pr?: { state: DevPrState };
	ci?: { summary: DevCiSummary };
};

const STOPPED: readonly DevSessionStatusValue[] = ["STOPPED", "EXPIRED", "ERROR"];

/** Vale consultar? Há PR em andamento (aberta/rascunho), sessão viva e checks ainda por terminar. */
export function shouldPollCi(view: PollView | undefined, noneAttempts = 0): boolean {
	if (!view?.pr) return false;
	if (STOPPED.includes(view.status)) return false;
	if (view.pr.state !== "open" && view.pr.state !== "draft") return false;
	if (!view.ci) return true;
	if (view.ci.summary === "pending") return true;
	return view.ci.summary === "none" && noneAttempts < CI_POLL_NONE_ATTEMPTS;
}

export type CiPollDeps = {
	getView: (sessionId: string) => PollView | undefined;
	refresh: (sessionId: string) => Promise<void>;
	sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	now: () => number;
	isHidden: () => boolean;
};

/** Laço de consulta de UM PR/sessão. Resolve quando termina (checks concluídos, sessão parada, limite ou abort). */
export async function runCiPoll(sessionId: string, signal: AbortSignal, deps: CiPollDeps, firstDelayMs = 1_500): Promise<"done" | "stopped" | "timeout" | "aborted" | "failed"> {
	const startedAt = deps.now();
	let attempt = 0;
	let noneAttempts = 0;
	let failures = 0;
	let delay = firstDelayMs;
	try {
		for (;;) {
			await deps.sleep(delay, signal);
			if (signal.aborted) return "aborted";
			if (deps.now() - startedAt > CI_POLL_MAX_MS) return "timeout";
			const before = deps.getView(sessionId);
			if (!shouldPollCi(before, noneAttempts)) return before && STOPPED.includes(before.status) ? "stopped" : "done";
			// Aba escondida: não gasta chamada; tenta de novo no próximo intervalo.
			if (deps.isHidden()) {
				delay = ciPollDelay(attempt);
				continue;
			}
			try {
				await deps.refresh(sessionId);
				failures = 0;
			} catch (error) {
				// 409 = sem PR ou sessão parada: não adianta insistir.
				if (typeof error === "object" && error !== null && "status" in error && (error as { status?: number }).status === 409) return "stopped";
				failures += 1;
				if (failures >= MAX_CONSECUTIVE_FAILURES) return "failed";
			}
			if (deps.getView(sessionId)?.ci?.summary === "none") noneAttempts += 1;
			attempt += 1;
			delay = ciPollDelay(attempt);
		}
	} catch {
		return "aborted";
	}
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(new Error("aborted"));
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("aborted"));
			},
			{ once: true },
		);
	});
}

/** Aplica a resposta do servidor ao painel como os eventos `dev_pr`/`dev_ci`. */
async function refreshIntoStore(sessionId: string): Promise<void> {
	const result = await refreshDevSessionCi(sessionId);
	ingestDevSessionEvent({ type: "dev_pr", sessionId, ...result.pr });
	ingestDevSessionEvent({ type: "dev_ci", sessionId, checks: result.checks, summary: result.summary });
}

const active = new Map<string, { count: number; controller: AbortController }>();

/**
 * Liga a consulta de checks da sessão (várias telas podem pedir: o laço é um só).
 * Devolve a função que desliga; o último a sair cancela o laço.
 */
export function startCiPolling(sessionId: string, overrides: Partial<CiPollDeps> = {}): () => void {
	const existing = active.get(sessionId);
	if (existing) {
		existing.count += 1;
	} else {
		const controller = new AbortController();
		active.set(sessionId, { count: 1, controller });
		const deps: CiPollDeps = {
			getView: (id) => getDevSessionSnapshot().sessions[id],
			refresh: refreshIntoStore,
			sleep: abortableSleep,
			now: Date.now,
			isHidden: () => typeof document !== "undefined" && document.hidden,
			...overrides,
		};
		void runCiPoll(sessionId, controller.signal, deps).finally(() => {
			if (active.get(sessionId)?.controller === controller) active.delete(sessionId);
		});
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const entry = active.get(sessionId);
		if (!entry) return;
		entry.count -= 1;
		if (entry.count <= 0) {
			entry.controller.abort();
			active.delete(sessionId);
		}
	};
}

/** Número de laços ativos (testes). */
export function activeCiPollCount(): number {
	return active.size;
}
