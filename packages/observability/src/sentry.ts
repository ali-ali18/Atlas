import * as Sentry from "@sentry/node";
import { resolveCommit, scrubSentryEvent, scrubString, type EnvLike } from "@workspace/shared";
import { currentRequestId } from "./request-context.js";

let enabled = false;

export function sentryEnabled(): boolean {
	return enabled;
}

/**
 * Liga o Sentry só se `SENTRY_DSN` existir. Sem DSN não faz nada. `release` é o commit; nada de
 * PII (padrão do SDK, sem IP/cookies) e todo evento/breadcrumb passa pelo scrub (Authorization, cookies,
 * chaves, `?secret=`...). Nunca lança.
 */
export function initSentry(service: string, env: EnvLike = process.env): boolean {
	const dsn = env.SENTRY_DSN?.trim();
	if (!dsn) return false;
	try {
		Sentry.init({
			dsn,
			release: resolveCommit(env) || undefined,
			environment: env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV || "production",
			serverName: service,
			includeServerName: false,
			tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE ?? 0) || 0,
			maxBreadcrumbs: 30,
			beforeSend: (event) => {
				const rid = currentRequestId();
				const scrubbed = scrubSentryEvent(event as never) as typeof event;
				if (rid) scrubbed.tags = { ...scrubbed.tags, request_id: rid };
				return scrubbed;
			},
			beforeBreadcrumb: (breadcrumb) => {
				if (breadcrumb.category === "console") {
					return { ...breadcrumb, message: breadcrumb.message ? scrubString(breadcrumb.message) : breadcrumb.message, data: undefined };
				}
				return scrubSentryEvent({ ...breadcrumb } as never) as typeof breadcrumb;
			},
		});
		Sentry.setTag("service", service);
		enabled = true;
		return true;
	} catch (error) {
		console.warn(`[sentry] ${service}: não iniciou (${error instanceof Error ? error.message : String(error)}); seguindo sem Sentry`);
		return false;
	}
}

/** Reporta um erro tratado (no-op sem Sentry). */
export function captureError(error: unknown, context?: Record<string, string | undefined>): void {
	if (!enabled) return;
	try {
		Sentry.withScope((scope) => {
			for (const [key, value] of Object.entries(context ?? {})) if (value) scope.setTag(key, value);
			Sentry.captureException(error);
		});
	} catch {
		// observabilidade nunca derruba o fluxo
	}
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
	if (!enabled) return;
	await Sentry.flush(timeoutMs).catch(() => undefined);
}
