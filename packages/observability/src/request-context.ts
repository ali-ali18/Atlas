import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { format } from "node:util";

/**
 * Request-id: nasce na API (header `x-request-id` ou novo), vai no AsyncLocalStorage, prefixa todo
 * `console.*` do mesmo fluxo e segue para o worker dentro do job (`requestId` no payload).
 */
const storage = new AsyncLocalStorage<{ requestId: string }>();

const SAFE_ID = /^[A-Za-z0-9._:-]{8,64}$/;

/** Aceita o id do cliente só se for curto e inofensivo (nada de quebra de linha nem injeção de log). */
export function sanitizeRequestId(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed && SAFE_ID.test(trimmed) ? trimmed : null;
}

export function newRequestId(): string {
	return randomUUID();
}

export function currentRequestId(): string | undefined {
	return storage.getStore()?.requestId;
}

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
	return storage.run({ requestId }, fn);
}

/** Id do job (campo `requestId` do payload) ou um id derivado do job, para o worker. */
export function requestIdForJob(job: { id?: string | undefined; data?: unknown }): string {
	const fromData = (job.data as { requestId?: unknown } | null | undefined)?.requestId;
	return (typeof fromData === "string" && sanitizeRequestId(fromData)) || `job-${job.id ?? newRequestId()}`;
}

let loggingInstalled = false;

/** Prefixa `[rid=...]` nos logs feitos dentro de um contexto com request-id. Idempotente. */
export function installRequestIdLogging(target: Pick<Console, "log" | "info" | "warn" | "error" | "debug"> = console): void {
	if (loggingInstalled) return;
	loggingInstalled = true;
	for (const level of ["log", "info", "warn", "error", "debug"] as const) {
		const original = target[level].bind(target);
		target[level] = (...args: unknown[]) => {
			const id = currentRequestId();
			if (!id) return original(...args);
			const [first, ...rest] = args;
			// Mantém strings de formato (%s) funcionando: o prefixo entra na primeira string.
			if (typeof first === "string") return original(`[rid=${id}] ${first}`, ...rest);
			return original(`[rid=${id}] ${format(...args)}`);
		};
	}
}

/** Só para testes: permite reinstalar o prefixo em outro alvo. */
export function resetRequestIdLoggingForTests(): void {
	loggingInstalled = false;
}
