import type { GithubWebhookTrigger } from "../routine-github.js";
import { parseGithubWebhookTrigger } from "../routine-github.js";
import type { OnceTriggerJson } from "../routine-once.js";
import { isOnceTrigger } from "../routine-once.js";
import type { IntervalTriggerJson } from "../routine-interval.js";
import { isIntervalTrigger } from "../routine-interval.js";
import type { EmailTriggerJson } from "../routine-email.js";
import { normalizeEmailTrigger } from "../routine-email.js";

/** Envelope estável: genérico e providers tipados convergem nisto antes do match. */
export type EventEnvelope = {
	/** v1: "generic" | futuro: "github" | "slack" | ... */
	provider: string;
	/** v1: "webhook.received" | futuro: "pr-opened", "message", ... */
	type: string;
	/** Quando o provedor enviou / recebemos (ISO). */
	occurredAt: string;
	/** Id para idempotência (header ou hash do body). */
	idempotencyKey?: string;
	/** Refs pra filtro (repo, channel, hookKey…). */
	refs: Record<string, string>;
	/** Body já parseado; pode ser truncado antes do prompt. */
	payload: unknown;
	/** Headers allowlist (nunca Authorization cru). */
	meta?: Record<string, string>;
};

/** Trigger persistido em Routine.triggerJson (kind discriminador). */
export type GenericWebhookTrigger = {
	kind: "generic";
	/** Slug público na URL (não é o secret). */
	hookKey: string;
	/** Hash do secret (nunca plaintext no DB). */
	secretHash: string;
	/** Cópia do secret selada no cofre do dono (`{{secret:rotina:...}}`); ausente em rotinas antigas até rotacionar. Nunca sai pela API. */
	secretEnc?: string;
	/** Última vez que a integração autenticou com ?secret= na URL (aviso de depreciação na UI). */
	urlSecretAt?: string;
	/** Default 65536. */
	maxBodyBytes?: number;
};

export type RoutineTriggerJson = GenericWebhookTrigger | GithubWebhookTrigger | OnceTriggerJson | IntervalTriggerJson | EmailTriggerJson;

export function isGenericWebhookTrigger(
	value: unknown,
): value is GenericWebhookTrigger {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return (
		row.kind === "generic" &&
		typeof row.hookKey === "string" &&
		row.hookKey.trim().length > 0 &&
		typeof row.secretHash === "string" &&
		row.secretHash.length > 0
	);
}

export function parseRoutineTriggerJson(
	value: unknown,
): RoutineTriggerJson | null {
	if (!value || typeof value !== "object") return null;
	const row = value as Record<string, unknown>;
	if (row.kind === "generic" && isGenericWebhookTrigger(value)) {
		return {
			kind: "generic",
			hookKey: String(row.hookKey).trim(),
			secretHash: String(row.secretHash),
			...(typeof row.secretEnc === "string" && row.secretEnc ? { secretEnc: row.secretEnc } : {}),
			...(typeof row.urlSecretAt === "string" && row.urlSecretAt ? { urlSecretAt: row.urlSecretAt } : {}),
			...(typeof row.maxBodyBytes === "number"
				? { maxBodyBytes: row.maxBodyBytes }
				: {}),
		};
	}
	if (row.kind === "github") {
		return parseGithubWebhookTrigger(value);
	}
	if (row.kind === "email") {
		return normalizeEmailTrigger(value);
	}
	if (row.kind === "once" && isOnceTrigger(value)) {
		return { kind: "once", runAt: String(row.runAt) };
	}
	if (row.kind === "interval" && isIntervalTrigger(value)) {
		return { kind: "interval", everyMinutes: Number(row.everyMinutes) };
	}
	return null;
}

export type RoutineHookInfo = {
	hookKey: string;
	url: string;
	/** Plaintext só no create/rotate. */
	secret?: string;
	/** A integração autenticou com o segredo na URL (?secret=) recentemente: prefira o cabeçalho. */
	urlSecretAt?: string;
	/** Só GitHub: link pronto pra cadastrar o webhook no repo. */
	setupUrl?: string;
};
