import { createHash } from "node:crypto";
import type { EventEnvelope, NormalizedGithubEvent } from "@workspace/shared";
import { normalizeGithubWebhook } from "@workspace/shared";

const META_ALLOWLIST = ["content-type", "user-agent", "x-request-id"] as const;

export function toEnvelopeGeneric(input: {
	hookKey: string;
	payload: unknown;
	headers: Record<string, string | undefined>;
	rawBody: string;
}): EventEnvelope {
	const idempotencyHeader =
		input.headers["x-atlas-idempotency-key"]?.trim() ||
		input.headers["idempotency-key"]?.trim();
	const idempotencyKey =
		idempotencyHeader ||
		createHash("sha256").update(input.rawBody).digest("hex");

	const meta: Record<string, string> = {};
	for (const key of META_ALLOWLIST) {
		const value = input.headers[key]?.trim();
		if (value) meta[key] = value;
	}

	return {
		provider: "generic",
		type: "webhook.received",
		occurredAt: new Date().toISOString(),
		idempotencyKey,
		refs: { hookKey: input.hookKey },
		payload: input.payload,
		meta: Object.keys(meta).length > 0 ? meta : undefined,
	};
}

/**
 * GitHub → EventEnvelope. Payload cru NUNCA vai pro envelope — só o dado
 * compacto normalizado (dado externo não confiável, nunca instrução).
 * Idempotência: X-GitHub-Delivery (sempre presente) > hash do body.
 */
export function toEnvelopeGithub(input: {
	githubEvent: string;
	deliveryId: string | undefined;
	payload: Record<string, unknown>;
	rawBody: string;
}): EventEnvelope | null {
	const [normalized] = normalizeGithubWebhook(input.githubEvent, input.payload);
	if (!normalized) return null;

	const idempotencyKey =
		input.deliveryId?.trim() ||
		createHash("sha256").update(input.rawBody).digest("hex");

	return {
		provider: "github",
		type: normalized.type,
		occurredAt: new Date().toISOString(),
		idempotencyKey,
		refs: {
			repo: normalized.repo,
			event: normalized.type,
		},
		payload: normalized satisfies NormalizedGithubEvent,
		meta: input.deliveryId ? { "x-github-delivery": input.deliveryId } : undefined,
	};
}
