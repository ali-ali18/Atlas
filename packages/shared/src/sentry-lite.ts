/**
 * Cliente mínimo do Sentry (envelope via `fetch`) para o web, onde um SDK pesado arriscaria o
 * bundle. Sem DSN não faz nada. Todo evento passa pelo scrub; nunca lança nem atrasa o app.
 * API/worker usam o SDK completo (`@workspace/observability`).
 */
import { resolveCommit, type EnvLike } from "./build-info.js";
import { scrubSentryEvent, scrubString } from "./scrub.js";

export type SentryDsn = { publicKey: string; endpoint: string };

/** `https://<key>@<host>/<projectId>` → endpoint do envelope. `null` se inválido. */
export function parseSentryDsn(dsn: string | undefined | null): SentryDsn | null {
	const text = dsn?.trim();
	if (!text) return null;
	try {
		const url = new URL(text);
		const projectId = url.pathname.split("/").filter(Boolean).pop();
		if (!url.username || !projectId || !/^https?:$/.test(url.protocol)) return null;
		return { publicKey: url.username, endpoint: `${url.protocol}//${url.host}/api/${projectId}/envelope/` };
	} catch {
		return null;
	}
}

export type LiteEventInput = {
	error: unknown;
	/** "web-server" | "web-client" */
	service: string;
	env: EnvLike;
	url?: string;
	tags?: Record<string, string>;
};

function errorType(error: unknown): { type: string; value: string; stack?: string } {
	if (error instanceof Error) return { type: error.name || "Error", value: scrubString(error.message), stack: error.stack ? scrubString(error.stack) : undefined };
	return { type: "Error", value: scrubString(typeof error === "string" ? error : "erro não-Error") };
}

export function buildLiteEvent(input: LiteEventInput, now: Date = new Date(), eventId: string = cryptoId()) {
	const { type, value, stack } = errorType(input.error);
	const event = {
		event_id: eventId,
		timestamp: now.getTime() / 1000,
		platform: "javascript",
		level: "error",
		release: resolveCommit(input.env) || undefined,
		environment: input.env.SENTRY_ENVIRONMENT?.trim() || input.env.NODE_ENV || "production",
		tags: { service: input.service, ...(input.tags ?? {}) },
		request: input.url ? { url: input.url } : undefined,
		exception: { values: [{ type, value, ...(stack ? { stacktrace: { frames: stack.split("\n").slice(0, 30).map((line) => ({ function: line.trim() })) } } : {}) }] },
	};
	return scrubSentryEvent(event);
}

function cryptoId(): string {
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Envia o erro ao Sentry (fire-and-forget). Retorna `false` sem DSN. */
export function captureLite(input: LiteEventInput, fetchImpl: typeof fetch = globalThis.fetch): boolean {
	const dsn = parseSentryDsn(input.env.SENTRY_DSN ?? input.env.NEXT_PUBLIC_SENTRY_DSN);
	if (!dsn || typeof fetchImpl !== "function") return false;
	try {
		const event = buildLiteEvent(input);
		const body = [
			JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() }),
			JSON.stringify({ type: "event" }),
			JSON.stringify(event),
		].join("\n");
		void fetchImpl(`${dsn.endpoint}?sentry_version=7&sentry_key=${dsn.publicKey}`, {
			method: "POST",
			headers: { "content-type": "application/x-sentry-envelope" },
			body,
			keepalive: true,
		}).catch(() => undefined);
		return true;
	} catch {
		return false;
	}
}
