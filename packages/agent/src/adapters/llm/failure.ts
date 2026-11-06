import type { ProviderHealthReason } from "@workspace/shared";
import { copyFor } from "../../copy/index.js";

// Classifica a falha de um provedor para decidir se a cadeia troca de entrada.
// Estrutural (status/code/name): o adaptador não depende das classes do legado.

export type FailureVerdict =
	| { kind: "switch"; reason: ProviderHealthReason; cooldownMs: number; /** false = falha só desta requisição (ex.: modelo sem visão): não põe o provedor em quarentena. */ markHealth: boolean }
	| { kind: "fatal" };

export type FailureCooldowns = { rateLimitMs: number; quotaMs: number; downMs: number; authMs: number };

export const DEFAULT_COOLDOWNS: FailureCooldowns = {
	rateLimitMs: 60_000,
	quotaMs: 15 * 60_000,
	downMs: 30_000,
	authMs: 15 * 60_000,
};

type ErrorLike = { status?: unknown; code?: unknown; name?: unknown; reason?: unknown; retryAfterMs?: unknown; message?: unknown };

export function classifyFailure(error: unknown, cooldowns: FailureCooldowns, signal?: AbortSignal): FailureVerdict {
	// Cancelamento do dono nunca vira troca de provedor.
	if (signal?.aborted) return { kind: "fatal" };
	const e = (error ?? {}) as ErrorLike;
	const status = typeof e.status === "number" ? e.status : undefined;
	const code = typeof e.code === "string" ? e.code : undefined;
	if (e.name === "AbortError") return { kind: "fatal" };
	if (e.reason === "no_image_support") return { kind: "switch", reason: "down", cooldownMs: 0, markHealth: false };
	const retryAfter = typeof e.retryAfterMs === "number" && e.retryAfterMs > 0 ? e.retryAfterMs : undefined;
	if (status === 429 || code === "rate_limited") return { kind: "switch", reason: "rate_limit", cooldownMs: retryAfter ?? cooldowns.rateLimitMs, markHealth: true };
	if (status === 402 || code === "limit_exceeded") return { kind: "switch", reason: "quota", cooldownMs: cooldowns.quotaMs, markHealth: true };
	if (status === 401 || status === 403 || code === "auth_failed") return { kind: "switch", reason: "down", cooldownMs: cooldowns.authMs, markHealth: true };
	if (code === "bad_request" || status === 400 || status === 404 || status === 422) return { kind: "fatal" };
	if (
		(status !== undefined && status >= 500) ||
		code === "unavailable" || code === "network_error" || code === "stream_interrupted" || code === "upstream_error" ||
		e.name === "TimeoutError" || e.name === "TypeError"
	) {
		return { kind: "switch", reason: "down", cooldownMs: cooldowns.downMs, markHealth: true };
	}
	return { kind: "fatal" };
}

/** Motivo no idioma do bot para o aviso ao dono. */
export function reasonText(reason: ProviderHealthReason, language?: unknown): string {
	switch (reason) {
		case "rate_limit":
			return copyFor(language, "reason_rate_limit");
		case "quota":
			return copyFor(language, "reason_quota");
		default:
			return copyFor(language, "reason_down");
	}
}
