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
const wasWorking = new Set<string>();

const IDLE_SIGNAL: AvatarSignal = { state: "idle", progress: null };

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
	const active = isBotWorking(botId);
	// Run novo: some a comemoração/erro do anterior (senão o avatar demora a mostrar o que o bot faz).
	if (active && !wasWorking.has(botId)) governor.begin();
	if (active) wasWorking.add(botId);
	else wasWorking.delete(botId);
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
	server = next;
	emit();
	for (const botId of touched) refreshBotAvatar(botId);
}

export function isBotWorking(botId: string) {
	return working.has(botId) || server.has(botId);
}

/** O ChatThread publica a atividade do run (ferramenta, escrevendo, pensando…) e o contexto dele. */
export function setBotActivity(botId: string, activity: AgentActivity, ctx: AvatarRunContext = {}, now: number = Date.now()) {
	if (!botId) return;
	details.set(botId, { activity, ctx });
	if (activity.phase === "thinking" && activity.toolFailed) governorOf(botId).event("failed", now);
	refreshBotAvatar(botId, now);
}

/** O run acabou: comemora (`ok`) ou faz cara de erro; depois o avatar volta ao repouso. */
export function endBotRun(botId: string, outcome: "ok" | "error", now: number = Date.now()) {
	if (!botId) return;
	details.delete(botId);
	governorOf(botId).event(outcome === "ok" ? "finished" : "failed", now);
	refreshBotAvatar(botId, now);
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
