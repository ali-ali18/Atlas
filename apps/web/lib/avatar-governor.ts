// Governador do avatar: decide O QUE mostrar agora a partir do que o bot quer
// mostrar (avatar-activity.ts) e dos eventos pontuais (falha, fim, passo novo).
// Evita pisca-pisca: cada estado de atividade fica no mínimo `minDwellMs` e, se o bot
// trocar de ferramenta várias vezes dentro disso, só a última vale (as do meio somem).
// Repouso, "pensando" e "trabalhando" genérico não seguram ninguém: sair deles é imediato.
// Depois que a ferramenta termina, a família dela continua na tela por `toolLingerMs` antes de
// voltar a "pensando" (o modelo leva alguns segundos para decidir; sem isso o avatar vivia pensando).
// O anel de progresso nunca aparece antes nem por cima do começo da ferramenta: só quando o mesmo
// passo dura mais que `progressAfterMs` (trabalho longo de verdade).
// Pura: o relógio é de quem chama (`now` em ms), sem timers aqui. Quem usa agenda
// o próximo `signal()` com `nextChangeMs()`.
import type { AvatarState } from "@workspace/ui/lib/avatar/model/behavior";

import type { AvatarDesired } from "./avatar-activity";

export const GOVERNOR_TUNING = {
	/** Tempo mínimo em cada estado (ms) antes de trocar por outro. */
	minDwellMs: 1200,
	/** Quanto tempo o mesmo passo de ferramenta precisa durar (ms) para o anel de progresso aparecer. */
	progressAfterMs: 3000,
	/** Anel de progresso (ms). O corpo vira anel e volta, então não pode ser curto demais. */
	progressFlashMs: 1000,
	/** Depois do resultado da ferramenta, a família dela segue na tela por este tempo (ms) antes de "pensando". */
	toolLingerMs: 2500,
	/** Intervalo mínimo entre dois anéis (ms): sem isso, run com passos rápidos viraria só anel e esconderia Lendo/Programando. */
	progressCooldownMs: 4000,
	/** Cara de erro depois de uma ferramenta que falhou (ms). */
	failedMs: 1800,
	/** Comemoração ao terminar o run (ms). */
	finishedMs: 2600,
} as const;

export type AvatarSignal = { state: AvatarState; progress: number | null };

type Transient = { state: "failed" | "finished"; until: number };

/** Estados de ferramenta específica (o passo vem do servidor); "working" só conta com `step`. */
const NON_TOOL_STATES: ReadonlySet<AvatarState> = new Set(["idle", "thinking", "streaming", "waiting", "progress", "failed", "finished"]);
const isToolDesired = (desired: AvatarDesired) => desired.step !== null && !NON_TOOL_STATES.has(desired.state);

export type AvatarGovernor = ReturnType<typeof createAvatarGovernor>;

export function createAvatarGovernor(tuning: typeof GOVERNOR_TUNING = GOVERNOR_TUNING) {
	let base: AvatarDesired = { state: "idle", step: null, progress: null };
	let lastStep: number | null = null;
	/** Passo novo esperando a vez de mostrar o anel (a permanência do estado atual pode segurá-lo). */
	let flashPending = false;
	let flashUntil = 0;
	/** Quando o passo atual começou (o anel só vale depois de `progressAfterMs`). */
	let stepSince = 0;
	/** Família da ferramenta que acabou de terminar, mantida até `until`. */
	let linger: { state: AvatarState; until: number } | null = null;
	/** Ferramenta que falhou não "persiste" na tela: a cara de erro já cobre esse tempo. */
	let lingerBlocked = false;
	/** Quando o último anel FOI mostrado (o intervalo só conta anel que apareceu). */
	let lastFlashAt = Number.NEGATIVE_INFINITY;
	let transient: Transient | null = null;
	let shown: AvatarState = "idle";
	let shownSince = Number.NEGATIVE_INFINITY;
	let progress: number | null = null;

	/** O anel só entra com a ferramenta já na tela e o mesmo passo durando além de `progressAfterMs`. */
	const ringDue = (now: number) =>
		flashPending && isToolDesired(base) && shown === base.state && now - stepSince >= tuning.progressAfterMs;

	/** O que deveria aparecer agora, sem a trava de permanência. */
	function target(now: number): { state: AvatarState; urgent: boolean } {
		if (transient && now < transient.until) return { state: transient.state, urgent: true };
		if (transient) transient = null;
		if ((ringDue(now) || now < flashUntil) && base.progress !== null) return { state: "progress", urgent: false };
		if (linger && now < linger.until && base.state === "thinking") return { state: linger.state, urgent: false };
		// Esperar o usuário não pode atrasar: o pedido de aprovação aparece na hora, sem esperar a permanência do estado anterior.
		return { state: base.state, urgent: base.state === "waiting" };
	}

	/** Só estados de atividade específica (pesquisando, lendo…) seguram a troca; o anel já tem tempo próprio. */
	const holds = () => shown !== "idle" && shown !== "working" && shown !== "progress" && shown !== "thinking";

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
			const previous = base;
			base = desired;
			if (desired.state !== "thinking") lingerBlocked = false;
			if (!lingerBlocked && isToolDesired(previous) && desired.state === "thinking") linger = { state: previous.state, until: now + tuning.toolLingerMs };
			else if (desired.state !== "thinking") linger = null;
			if (desired.progress === null) flashPending = false;
			if (desired.step === null) {
				if (desired.state === "idle") flashPending = false;
				if (desired.state === "idle") lastStep = null;
			} else {
				if (desired.step !== lastStep && desired.progress !== null && now - lastFlashAt >= tuning.progressCooldownMs) {
					flashPending = true;
				}
				if (desired.step !== lastStep) stepSince = now;
				lastStep = desired.step;
			}
		},
		/** Ferramenta falhou / run terminou: reação imediata, depois volta ao que o bot estiver fazendo. */
		event(kind: "failed" | "finished", now: number): void {
			transient = { state: kind, until: now + (kind === "failed" ? tuning.failedMs : tuning.finishedMs) };
			linger = null;
			lingerBlocked = true;
			if (kind === "finished") {
				flashUntil = 0;
				flashPending = false;
			}
		},
		/** Run novo começando: esquece a comemoração/erro do run anterior e o passo (o anel acende no passo 0). */
		begin(): void {
			transient = null;
			linger = null;
			lingerBlocked = false;
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
			if (linger) consider(linger.until - now);
			if (flashPending && isToolDesired(base) && shown === base.state) consider(stepSince + tuning.progressAfterMs - now);
			return soonest;
		},
	};
}
