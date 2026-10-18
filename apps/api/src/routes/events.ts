import { Hono } from "hono";
import {
	getUserEventStore,
	parseEventCursor,
	planReplay,
	USER_EVENT_RETENTION_MS,
	type UserEventRecord,
	type UserEventStore,
} from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import { createRunObserver } from "./run-observer.js";

/**
 * `GET /v1/events`: canal único por usuário. Entrega o log ordenado (`user_events`) por SSE, com o `seq`
 * como `id` (retomada por `Last-Event-ID`). Sem cursor: manda `ready` com o fim do log e o cliente busca
 * os snapshots. Cursor velho/estranho: manda `resync` e segue do fim. Keepalive a cada 15 s.
 */

export const EVENTS_POLL_MS = 600;
export const EVENTS_KEEPALIVE_MS = 15_000;
const EVENTS_BATCH = 200;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/** `REALTIME_HUB=0|false|off` desliga o endpoint (404); o cliente cai no comportamento antigo. */
export function realtimeHubEnabled(env: Record<string, string | undefined> = process.env): boolean {
	const value = env.REALTIME_HUB?.trim().toLowerCase();
	return !(value === "0" || value === "false" || value === "off" || value === "no");
}

export function sseFrame(event: { id?: number; event?: string; data: unknown }): string {
	const lines: string[] = [];
	if (event.id !== undefined) lines.push(`id: ${event.id}`);
	if (event.event) lines.push(`event: ${event.event}`);
	lines.push(`data: ${JSON.stringify(event.data)}`);
	return `${lines.join("\n")}\n\n`;
}

export type UserEventStreamIo = {
	stopped: () => boolean;
	send: (frame: string) => void;
	wait: (ms: number) => Promise<void>;
};

export type UserEventStreamOptions = {
	store: UserEventStore;
	userId: string;
	/** Cursor da retomada (`Last-Event-ID`/`after`); null = conexão nova. */
	cursor: number | null;
	io: UserEventStreamIo;
	pollMs?: number;
	keepaliveMs?: number;
	now?: () => number;
};

function eventFrame(event: UserEventRecord): string {
	return sseFrame({ id: event.seq, event: event.type, data: { seq: event.seq, type: event.type, payload: event.payload, at: event.createdAt } });
}

/**
 * Laço do stream (separado da rota para testar sem HTTP). Termina quando `io.stopped()`.
 * Erro de leitura do banco não derruba a conexão: a próxima volta tenta de novo (o cliente só vê silêncio,
 * e o watchdog dele reconecta se durar).
 */
export async function runUserEventStream(options: UserEventStreamOptions): Promise<void> {
	const { store, userId, io } = options;
	const pollMs = options.pollMs ?? EVENTS_POLL_MS;
	const keepaliveMs = options.keepaliveMs ?? EVENTS_KEEPALIVE_MS;
	const now = options.now ?? Date.now;
	io.send("retry: 2000\n\n");
	let lastSentAt = now();
	let cursor = options.cursor;
	let started = false;

	const send = (frame: string) => {
		io.send(frame);
		lastSentAt = now();
	};

	while (!io.stopped()) {
		try {
			if (!started) {
				const plan = await planReplay(store, userId, cursor, EVENTS_BATCH);
				if (io.stopped()) return;
				started = true;
				if (plan.kind === "fresh") {
					cursor = plan.head;
					send(sseFrame({ id: plan.head, event: "ready", data: { head: plan.head } }));
				} else if (plan.kind === "resync") {
					cursor = plan.head;
					send(sseFrame({ id: plan.head, event: "resync", data: { head: plan.head } }));
				} else {
					if (cursor === 0 && plan.head === 0) send(sseFrame({ id: 0, event: "ready", data: { head: 0 } }));
					for (const event of plan.events) {
						send(eventFrame(event));
						cursor = event.seq;
					}
					if (plan.events.length === EVENTS_BATCH) continue;
				}
			} else {
				const events = await store.listAfter(userId, cursor ?? 0, EVENTS_BATCH);
				if (io.stopped()) return;
				if (events.length > 0 && events[0]!.seq !== (cursor ?? 0) + 1) {
					// o log foi podado por baixo da conexão: o cliente refaz os snapshots
					const head = await store.head(userId);
					cursor = head;
					send(sseFrame({ id: head, event: "resync", data: { head } }));
				} else {
					for (const event of events) {
						send(eventFrame(event));
						cursor = event.seq;
					}
					if (events.length === EVENTS_BATCH) continue;
				}
			}
		} catch (error) {
			console.warn(`[events] leitura falhou reason=${error instanceof Error ? error.name : "unknown"}`);
		}
		if (now() - lastSentAt >= keepaliveMs) send(": keepalive\n\n");
		await io.wait(pollMs);
	}
}

export function createEventRoutes(store: UserEventStore = getUserEventStore(), env: Record<string, string | undefined> = process.env) {
	const app = new Hono<AuthEnv>();
	let lastPruneAt = 0;

	app.get("/v1/events", (c) => {
		if (!realtimeHubEnabled(env)) return c.json({ error: "Not found" }, 404);
		const { userId } = scopeFor(c.get("session"));
		const cursor = parseEventCursor(c.req.header("Last-Event-ID") ?? c.req.query("after"));

		// Poda do log velho (uma vez por hora por processo; melhor esforço).
		if (Date.now() - lastPruneAt > PRUNE_EVERY_MS) {
			lastPruneAt = Date.now();
			void store.prune(new Date(Date.now() - USER_EVENT_RETENTION_MS)).catch(() => undefined);
		}

		const encoder = new TextEncoder();
		const stream = createRunObserver(c.req.raw.signal, async (observer) => {
			await runUserEventStream({
				store,
				userId,
				cursor,
				io: {
					stopped: observer.stopped,
					send: (frame) => observer.send(encoder.encode(frame)),
					wait: observer.wait,
				},
			});
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			},
		});
	});

	return app;
}
