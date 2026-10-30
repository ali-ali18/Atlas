// Governador do avatar: decide O QUE mostrar agora a partir do que o bot quer
// mostrar (avatar-activity.ts) e dos eventos pontuais (falha, fim, passo novo).
// Evita pisca-pisca: cada estado de atividade fica no mínimo `minDwellMs` e, se o bot
// trocar de ferramenta várias vezes dentro disso, só a última vale (as do meio somem).
// Repouso e "trabalhando" genérico não seguram ninguém: sair deles é imediato.
// Pura: o relógio é de quem chama (`now` em ms), sem timers aqui. Quem usa agenda
// o próximo `signal()` com `nextChangeMs()`.
import type { AvatarState } from "@workspace/ui/lib/avatar/model/behavior";

import type { AvatarDesired } from "./avatar-activity";

export const GOVERNOR_TUNING = {
	/** Tempo mínimo em cada estado (ms) antes de trocar por outro. */
	minDwellMs: 1200,
	/** Anel de progresso depois de um passo novo (ms). O corpo vira anel e volta, então não pode ser curto demais. */
	progressFlashMs: 1000,
	/** Intervalo mínimo entre dois anéis (ms): sem isso, run com passos rápidos viraria só anel e esconderia Lendo/Programando. */
	progressCooldownMs: 4000,
	/** Cara de erro depois de uma ferramenta que falhou (ms). */
	failedMs: 1800,
	/** Comemoração ao terminar o run (ms). */
	finishedMs: 2600,
} as const;

export type AvatarSignal = { state: AvatarState; progress: number | null };

type Transient = { state: "failed" | "finished"; until: number };

export type AvatarGovernor = ReturnType<typeof createAvatarGovernor>;

export function createAvatarGovernor(tuning: typeof GOVERNOR_TUNING = GOVERNOR_TUNING) {
	let base: AvatarDesired = { state: "idle", step: null, progress: null };
	let lastStep: number | null = null;
	/** Passo novo esperando a vez de mostrar o anel (a permanência do estado atual pode segurá-lo). */
	let flashPending = false;
	let flashUntil = 0;
	/** Quando o último anel FOI mostrado (o intervalo só conta anel que apareceu). */
	let lastFlashAt = Number.NEGATIVE_INFINITY;
	let transient: Transient | null = null;
	let shown: AvatarState = "idle";
	let shownSince = Number.NEGATIVE_INFINITY;
	let progress: number | null = null;

	/** O que deveria aparecer agora, sem a trava de permanência. */
	function target(now: number): { state: AvatarState; urgent: boolean } {
		if (transient && now < transient.until) return { state: transient.state, urgent: true };
		if (transient) transient = null;
		if ((flashPending || now < flashUntil) && base.progress !== null) return { state: "progress", urgent: false };
		return { state: base.state, urgent: false };
	}

	/** Só estados de atividade específica (pesquisando, lendo…) seguram a troca; o anel já tem tempo próprio. */
	const holds = () => shown !== "idle" && shown !== "working" && shown !== "progress";

	function settle(now: number): AvatarSignal {
		const want = target(now);
		if (want.state !== shown && (want.urgent || !holds() || now - shownSince >= tuning.minDwellMs)) {
			shown = want.state;
			shownSince = now;
			if (shown === "progress" && flashPending) {
				flashPending = false;
				flashUntil = now + tuning.progressFlashMs;
				lastFlashAt = now;
			}
		}
		// O anel de progresso mostra a fração do passo; fora do estado `progress` não importa.
		progress = base.progress;
		return { state: shown, progress };
	}

	return {
		/** O que o bot quer mostrar (a cada mudança de atividade).  */
		push(desired: AvatarDesired, now: number): void {
			base = desired;
			if (desired.progress === null) flashPending = false;
			if (desired.step === null) {
				if (desired.state === "idle") flashPending = false;
				if (desired.state === "idle") lastStep = null;
			} else {
				if (desired.step !== lastStep && desired.progress !== null && now - lastFlashAt >= tuning.progressCooldownMs) {
					flashPending = true;
				}
				lastStep = desired.step;
			}
		},
		/** Ferramenta falhou / run terminou: reação imediata, depois volta ao que o bot estiver fazendo. */
		event(kind: "failed" | "finished", now: number): void {
			transient = { state: kind, until: now + (kind === "failed" ? tuning.failedMs : tuning.finishedMs) };
			if (kind === "finished") {
				flashUntil = 0;
				flashPending = false;
			}
		},
		/** Run novo começando: esquece a comemoração/erro do run anterior e o passo (o anel acende no passo 0). */
		begin(): void {
			transient = null;
			flashPending = false;
			flashUntil = 0;
			lastFlashAt = Number.NEGATIVE_INFINITY;
			lastStep = null;
			// O que estava na tela era do run anterior: não segura o primeiro estado do novo.
			shownSince = Number.NEGATIVE_INFINITY;
		},
		/** Estado e fração para mostrar agora (pode mudar sem novo `push`, só pelo tempo). */
		signal(now: number): AvatarSignal {
			return settle(now);
		},
		/** ms até o sinal poder mudar só pelo tempo; `null` = nada agendado. */
		nextChangeMs(now: number): number | null {
			const want = target(now);
			let soonest: number | null = null;
			const consider = (ms: number) => {
				if (ms > 0 && (soonest === null || ms < soonest)) soonest = ms;
			};
			if (want.state !== shown && holds()) consider(shownSince + tuning.minDwellMs - now);
			if (transient) consider(transient.until - now);
			if (now < flashUntil) consider(flashUntil - now);
			return soonest;
		},
	};
}
