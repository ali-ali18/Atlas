import { EventHub, HubAuthError, HubUnsupportedError, type HubFrame, type HubStatus, type HubTransport } from "./event-hub";
import { subscribeAppResume } from "./resume-sync";

/**
 * Cola do EventHub com o navegador: transporte SSE por `fetch`, instância única por aba e a regra de
 * "quando ainda vale consultar de tempos em tempos".
 */

/** `NEXT_PUBLIC_REALTIME_HUB=0` desliga o hub no cliente (volta aos polls antigos). */
export function hubEnabled(env: Record<string, string | undefined> = { NEXT_PUBLIC_REALTIME_HUB: process.env.NEXT_PUBLIC_REALTIME_HUB }): boolean {
	const value = env.NEXT_PUBLIC_REALTIME_HUB?.trim().toLowerCase();
	return !(value === "0" || value === "false" || value === "off");
}

/** Lê um bloco SSE (`id:`/`event:`/`data:`) do `/v1/events`. null = comentário/keepalive/bloco ilegível. */
export function parseHubBlock(block: string): HubFrame | null {
	let name: string | undefined;
	const data: string[] = [];
	for (const raw of block.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("event:")) name = line.slice(6).trim();
		else if (line.startsWith("data:")) data.push(line.slice(5).trim());
	}
	if (data.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(data.join("\n"));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const body = parsed as Record<string, unknown>;
	if (name === "ready" || name === "resync") {
		const head = typeof body.head === "number" ? body.head : Number.NaN;
		return Number.isFinite(head) ? { kind: name, head } : null;
	}
	if (typeof body.seq !== "number" || typeof body.type !== "string") return null;
	const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? (body.payload as Record<string, unknown>) : {};
	return { kind: "event", event: { seq: body.seq, type: body.type, payload, at: typeof body.at === "string" ? body.at : undefined } };
}

export function createFetchHubTransport(base = "", fetchImpl: typeof fetch = (...args) => fetch(...args)): HubTransport {
	return async ({ cursor, signal, onFrame }) => {
		const response = await fetchImpl(`${base}/v1/events`, {
			method: "GET",
			credentials: "same-origin",
			headers: { Accept: "text/event-stream", ...(cursor !== null ? { "Last-Event-ID": String(cursor) } : {}) },
			signal,
		});
		if (response.status === 401 || response.status === 403) throw new HubAuthError();
		if (response.status === 404 || response.status === 405 || response.status === 501) throw new HubUnsupportedError();
		if (!response.ok) throw new Error(`events http ${response.status}`);
		// Um proxy/rewrite sem a rota devolve HTML 200: sem SSE não há hub.
		if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) throw new HubUnsupportedError("not an event stream");
		if (!response.body) throw new Error("events stream empty");
		onFrame({ kind: "activity" });
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) return;
				onFrame({ kind: "activity" });
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split("\n\n");
				buffer = parts.pop() ?? "";
				for (const part of parts) {
					const frame = parseHubBlock(part);
					if (frame) onFrame(frame);
				}
			}
		} catch (error) {
			if (signal.aborted) return;
			throw error;
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	};
}

let shared: EventHub | null | undefined;

/** Instância única da aba (criada sob demanda, sem conectar). null no servidor ou com o hub desligado. */
export function getSharedEventHub(): EventHub | null {
	if (typeof window === "undefined" || !hubEnabled()) return null;
	if (shared === undefined) shared = new EventHub({ transport: createFetchHubTransport() });
	return shared;
}

/** Conecta (idempotente) e liga a reconexão ao voltar do segundo plano. Devolve a função de parada. */
export function startSharedEventHub(): () => void {
	const hub = getSharedEventHub();
	if (!hub) return () => undefined;
	hub.start();
	const unsubscribe = subscribeAppResume(() => hub.poke());
	return () => {
		unsubscribe();
		hub.stop();
	};
}

/**
 * Como consultar o servidor de tempos em tempos:
 * - `hub`: conectado, o hub avisa; sem consulta periódica.
 * - `degraded`: conectando/desconectado; só uma consulta de segurança, bem lenta.
 * - `legacy`: sem hub (desligado, servidor antigo, fora do provider); comportamento antigo.
 */
export type HubPollMode = "hub" | "degraded" | "legacy";

export function pollModeFor(status: HubStatus | null | undefined): HubPollMode {
	if (status === "connected") return "hub";
	if (status === "connecting" || status === "disconnected") return "degraded";
	return "legacy";
}

export function currentPollMode(): HubPollMode {
	return pollModeFor(getSharedEventHub()?.getStatus());
}

/** Intervalo da consulta de segurança quando o hub está fora do ar. */
export const DEGRADED_POLL_MS = 60_000;

/**
 * Decide se um tick de consulta periódica deve rodar: `legacy` sempre (comportamento antigo); `degraded`
 * só uma vez por `DEGRADED_POLL_MS`; `hub` nunca. `lastRunAt` é do chamador.
 */
export function shouldPollTick(mode: HubPollMode, now: number, lastRunAt: number): boolean {
	if (mode === "legacy") return true;
	if (mode === "degraded") return now - lastRunAt >= DEGRADED_POLL_MS;
	return false;
}
