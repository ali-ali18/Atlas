// Quais bots estão rodando agora, e o que cada um está fazendo (ChatThread publica,
// sidebar, cabeçalho e painel leem). O hook de chat vive dentro do ChatThread; este mapa
// leva o sinal aos avatares vivos sem subir estado para o template inteiro.
import { useSyncExternalStore } from "react";

import {
	GENERIC_WORKING,
	IDLE_DESIRED,
	avatarStateForActivity,
	type AvatarRunContext,
} from "./avatar-activity";
import { createAvatarGovernor, type AvatarGovernor, type AvatarSignal } from "./avatar-governor";
import type { AgentActivity } from "./working-status";

// Duas fontes que se somam: `working` (ChatThread aberto, resposta imediata) e `server` (runs em andamento
// vindos de GET /v1/bots: rotina, evento, delegação, outro dispositivo). Trabalhando = qualquer uma.
const working = new Set<string>();
let server = new Set<string>();
const listeners = new Set<() => void>();

/** Atividade detalhada, só para quem tem o ChatThread aberto (o servidor só diz "trabalhando"). */
type Detail = { activity: AgentActivity; ctx: AvatarRunContext };
const details = new Map<string, Detail>();
const governors = new Map<string, AvatarGovernor>();
const signals = new Map<string, AvatarSignal>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * Bots cujo run local acabou enquanto o servidor ainda os lista como trabalhando (a lista só
 * atualiza no próximo poll): o fim local vale até um poll mostrar o bot fora da lista.
 */
const endedLocally = new Map<string, number>();
/** Depois do fim local, o servidor que ainda lista o bot (poll em voo) é ignorado por este tempo (ms). */
const ENDED_GRACE_MS = 20_000;

const IDLE_SIGNAL: AvatarSignal = { state: "idle", progress: null };

export type BotPulseKind = "toolStart" | "toolOk" | "toolFail";
type PulseListener = (kind: BotPulseKind, strength: number) => void;
const pulseListeners = new Map<string, Set<PulseListener>>();

function emit() {
	for (const listener of listeners) listener();
}

function governorOf(botId: string): AvatarGovernor {
	let governor = governors.get(botId);
	if (!governor) {
		governor = createAvatarGovernor();
		governors.set(botId, governor);
	}
	return governor;
}

/**
 * Recalcula o sinal do avatar do bot. Chamado a cada mudança e pelo timer do governador
 * (a troca por tempo: permanência mínima, fim da cara de erro). `now` é injetável.
 */
export function refreshBotAvatar(botId: string, now: number = Date.now()): AvatarSignal {
	const governor = governorOf(botId);
	const detail = details.get(botId);
	const active = isBotWorking(botId, now);
	const desired = !active
		? IDLE_DESIRED
		: detail
			? avatarStateForActivity(detail.activity, detail.ctx)
			: GENERIC_WORKING;
	governor.push(desired, now);
	const next = governor.signal(now);
	const previous = signals.get(botId) ?? IDLE_SIGNAL;
	if (next.state !== previous.state || next.progress !== previous.progress) {
		signals.set(botId, next);
		emit();
	}
	const wait = governor.nextChangeMs(now);
	// Repouso e sem nada agendado: não guarda estado por bot (a lista de bots pode ser grande e longa).
	if (!active && next.state === "idle" && wait === null) {
		governors.delete(botId);
		signals.delete(botId);
		details.delete(botId);
	}
	const pending = timers.get(botId);
	if (pending) clearTimeout(pending);
	timers.delete(botId);
	if (wait !== null && typeof setTimeout === "function") {
		const timer = setTimeout(() => {
			timers.delete(botId);
			refreshBotAvatar(botId);
		}, Math.ceil(wait) + 5);
		// Em teste/SSR o timer não pode segurar o processo.
		(timer as { unref?: () => void }).unref?.();
		timers.set(botId, timer);
	}
	return next;
}

export function setBotWorking(botId: string, isWorking: boolean) {
	if (!botId || working.has(botId) === isWorking) return;
	if (isWorking) working.add(botId);
	else working.delete(botId);
	if (!isWorking) details.delete(botId);
	emit();
	refreshBotAvatar(botId);
}

/** Substitui o conjunto vindo do servidor (a lista inteira de bots a cada consulta). */
export function setServerWorking(botIds: Iterable<string>) {
	const next = new Set([...botIds].filter(Boolean));
	if (next.size === server.size && [...next].every((id) => server.has(id))) return;
	const touched = new Set([...server, ...next]);
	// Um poll sem o bot encerra a supressão: se ele voltar, é um run novo.
	for (const id of [...endedLocally.keys()]) if (!next.has(id)) endedLocally.delete(id);
	server = next;
	emit();
	for (const botId of touched) refreshBotAvatar(botId);
}

export function isBotWorking(botId: string, now: number = Date.now()) {
	const until = endedLocally.get(botId);
	const suppressed = until !== undefined && now < until;
	return working.has(botId) || (server.has(botId) && !suppressed);
}

/** Gesto do cérebro que a mudança de atividade pede: ferramenta nova começa; depois dela, ok ou falha. */
function pulseFor(previous: AgentActivity | undefined, next: AgentActivity): BotPulseKind | null {
	if (next.phase === "tool") {
		const same = previous?.phase === "tool" && previous.tool === next.tool && previous.step === next.step;
		return same ? null : "toolStart";
	}
	if (next.phase === "thinking" && previous?.phase === "tool") return next.toolFailed ? "toolFail" : "toolOk";
	return null;
}

/** O ChatThread publica a atividade do run (ferramenta, escrevendo, pensando…) e o contexto dele. */
export function setBotActivity(botId: string, activity: AgentActivity, ctx: AvatarRunContext = {}, now: number = Date.now()) {
	if (!botId) return;
	const previous = details.get(botId)?.activity;
	details.set(botId, { activity, ctx });
	// Mesmo objeto = só o contexto mudou (status, aprovação): não é um evento novo (não repete o erro).
	if (previous !== activity) {
		if (activity.phase === "thinking" && activity.toolFailed) governorOf(botId).event("failed", now);
		const pulse = pulseFor(previous, activity);
		if (pulse) pulseBot(botId, pulse, 1);
	}
	refreshBotAvatar(botId, now);
}

/** Run local começando: esquece a comemoração/erro do anterior e deixa o servidor voltar a valer. */
export function beginBotRun(botId: string, now: number = Date.now()) {
	if (!botId) return;
	endedLocally.delete(botId);
	governorOf(botId).begin();
	refreshBotAvatar(botId, now);
}

/**
 * O run acabou: comemora (`ok`), faz cara de erro (`error`) ou volta ao repouso sem reação
 * (`cancel`: foi o usuário que parou). O fim local vale mesmo que o poll do servidor ainda
 * liste o bot por mais um instante.
 */
export function endBotRun(botId: string, outcome: "ok" | "error" | "cancel", now: number = Date.now()) {
	if (!botId) return;
	details.delete(botId);
	// Sempre: um poll que já estava em voo quando o run acabou ainda pode listar o bot.
	endedLocally.set(botId, now + ENDED_GRACE_MS);
	if (outcome !== "cancel") governorOf(botId).event(outcome === "ok" ? "finished" : "failed", now);
	refreshBotAvatar(botId, now);
}

/** Pulso pontual (ferramenta começou/acabou/falhou, rajada de texto) para o cérebro do avatar. */
export function pulseBot(botId: string, kind: BotPulseKind, strength = 1) {
	for (const listener of pulseListeners.get(botId) ?? []) listener(kind, strength);
}

export function subscribeBotPulses(botId: string, listener: PulseListener): () => void {
	let set = pulseListeners.get(botId);
	if (!set) {
		set = new Set();
		pulseListeners.set(botId, set);
	}
	const mine = set;
	mine.add(listener);
	return () => {
		mine.delete(listener);
		if (mine.size === 0 && pulseListeners.get(botId) === mine) pulseListeners.delete(botId);
	};
}

/** Quantos bots têm estado guardado (diagnóstico e testes: tem de voltar a zero com todos em repouso). */
export function botActivityStateSize(): { governors: number; signals: number; details: number } {
	return { governors: governors.size, signals: signals.size, details: details.size };
}

export function botAvatarSignal(botId: string): AvatarSignal {
	return signals.get(botId) ?? IDLE_SIGNAL;
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useBotWorking(botId: string | undefined) {
	return useSyncExternalStore(
		subscribe,
		() => (botId ? isBotWorking(botId) : false),
		() => false,
	);
}

/** Estado do avatar do bot (o que ele está fazendo, com permanência mínima) e fração do passo. */
export function useBotAvatar(botId: string | undefined): AvatarSignal {
	return useSyncExternalStore(
		subscribe,
		() => (botId ? botAvatarSignal(botId) : IDLE_SIGNAL),
		() => IDLE_SIGNAL,
	);
}
