import { Hono } from "hono";
import type { RoutineQueue } from "@workspace/queue";
import { toEnvelopeGeneric } from "./normalize.js";
import { listGenericHookKeysForDiagnostics, recordHookUrlSecretUse } from "@workspace/db";
import {
	authorizeHookSecret,
	enqueueMatchedRoutineEvents,
	matchGenericHookRoutines,
} from "./dispatch.js";

const DEFAULT_MAX_BODY = 65_536;

/**
 * Todos os segredos enviados (cabeçalho X-Atlas-Hook-Secret, Bearer e ?secret=).
 * Basta UM valer: depois de "Gerar nova chave" é comum sobrar a chave antiga
 * num lugar (ex.: Dokploy com cabeçalho antigo + URL nova) — antes o cabeçalho
 * tinha precedência e a URL certa era ignorada (401). A URL com query nunca é logada.
 */
function extractSecrets(c: {
	req: {
		header: (name: string) => string | undefined;
		query: (name: string) => string | undefined;
	};
}): string[] {
	const auth = c.req.header("Authorization")?.trim();
	const candidates = [
		c.req.header("X-Atlas-Hook-Secret")?.trim(),
		auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined,
		c.req.query("secret")?.trim(),
	];
	return [...new Set(candidates.filter((value): value is string => !!value))];
}

export const HOOK_METHOD_HINT =
	"Use POST com o segredo no cabeçalho X-Atlas-Hook-Secret (ou Authorization: Bearer) ou em ?secret=";

function headerMap(c: {
	req: { header: (name: string) => string | undefined };
}): Record<string, string | undefined> {
	return {
		"content-type": c.req.header("content-type"),
		"user-agent": c.req.header("user-agent"),
		"x-request-id": c.req.header("x-request-id"),
		"x-atlas-idempotency-key": c.req.header("x-atlas-idempotency-key"),
		"idempotency-key": c.req.header("idempotency-key"),
	};
}

export type GenericHookDeps = {
	matchRoutines: typeof matchGenericHookRoutines;
	enqueue: typeof enqueueMatchedRoutineEvents;
	/** Marca a rotina que autenticou com ?secret= (aviso na UI). */
	markUrlSecret?: (routineId: string) => Promise<void>;
};

export const URL_SECRET_DEPRECATION = "O segredo na URL (?secret=) está obsoleto: envie o cabeçalho X-Atlas-Hook-Secret.";

export function createGenericHookRoutes(
	routineQueue: RoutineQueue | null,
	deps: GenericHookDeps = {
		matchRoutines: matchGenericHookRoutines,
		enqueue: enqueueMatchedRoutineEvents,
		markUrlSecret: recordHookUrlSecretUse,
	},
) {
	const app = new Hono();

	// Navegador/healthcheck: dica em vez de 404. Igual para qualquer hookKey
	// (não revela se existe).
	app.get("/v1/hooks/:hookKey", (c) => {
		c.header("Allow", "POST");
		return c.json({ error: "Method Not Allowed", hint: HOOK_METHOD_HINT }, 405);
	});

	app.post("/v1/hooks/:hookKey", async (c) => {
		const hookKey = c.req.param("hookKey")?.trim();
		if (!hookKey) return c.json({ error: "Missing hook key" }, 400);
		if (!routineQueue) {
			return c.json({ error: "Fila de rotinas indisponível" }, 503);
		}

		const matches = await deps.matchRoutines(hookKey);
		if (matches.length === 0) {
			const known = await listGenericHookKeysForDiagnostics().catch(() => []);
			console.warn(
				`[routine-event] webhook genérico: nenhuma rotina com a chave de URL "${hookKey}" (len ${hookKey.length}). Chaves existentes: ${
					known.map((k) => `${k.hookKey} [${k.enabled ? "on" : "off"} ${k.triggerType} ${k.routineId}]`).join(", ") || "nenhuma"
				}`,
			);
			return c.json({ error: "Hook not found" }, 404);
		}

		const allAuthorized = [
			...new Set(extractSecrets(c).flatMap((secret) => authorizeHookSecret(secret, matches))),
		];
		if (allAuthorized.length === 0) {
			console.warn("[routine-event] webhook genérico: chave (secret) inválida ou ausente");
			return c.json({ error: "Unauthorized" }, 401);
		}
		// ?secret= continua valendo (integrações existentes), mas só quando o cabeçalho/Bearer não autenticou:
		// avisa (sem logar o valor) e marca a rotina para a UI recomendar o cabeçalho.
		const headerSecrets = extractSecrets(c).filter((value) => value !== c.req.query("secret")?.trim());
		const authorizedByHeader = headerSecrets.some((secret) => authorizeHookSecret(secret, matches).length > 0);
		const urlSecret = c.req.query("secret")?.trim();
		if (urlSecret && !authorizedByHeader && authorizeHookSecret(urlSecret, matches).length > 0) {
			console.warn(`[routine-event] DEPRECATED: webhook autenticado com ?secret= na URL (hook ${hookKey}); use o cabeçalho X-Atlas-Hook-Secret`);
			c.header("Warning", `299 - "${URL_SECRET_DEPRECATION}"`);
			for (const row of allAuthorized) void deps.markUrlSecret?.(row.routine.id)?.catch(() => undefined);
		}
		// Pausada só se revela a quem provou a chave (sem vazar existência).
		const authorized = allAuthorized.filter((row) => row.routine.enabled);
		if (authorized.length === 0) {
			console.warn(`[routine-event] webhook genérico: rotina pausada routine=${allAuthorized[0]?.routine.id}`);
			return c.json({ error: "Rotina pausada", hint: "Ligue a rotina no Atlas para receber este webhook." }, 409);
		}

		const maxBody = Math.max(
			...authorized.map((row) => row.maxBodyBytes || DEFAULT_MAX_BODY),
		);

		const rawBody = await c.req.text();
		if (Buffer.byteLength(rawBody, "utf8") > maxBody) {
			return c.json({ error: "Payload too large" }, 413);
		}

		// Aceita JSON mesmo com content-type fora do padrão (ex.: text/plain de
		// serviços que não deixam configurar); só rejeita se não for JSON válido.
		const isJsonType = (c.req.header("content-type") ?? "")
			.toLowerCase()
			.includes("application/json");
		let payload: unknown;
		try {
			payload = rawBody.trim() ? JSON.parse(rawBody) : {};
		} catch {
			return isJsonType
				? c.json({ error: "Invalid JSON body" }, 400)
				: c.json({ error: "Body must be valid JSON (application/json)" }, 415);
		}

		const envelope = toEnvelopeGeneric({
			hookKey,
			payload,
			headers: headerMap(c),
			rawBody,
		});

		const runs = await deps.enqueue(
			routineQueue,
			authorized,
			envelope,
		);
		if (runs.length === 0) {
			return c.json({ error: "Failed to enqueue" }, 503);
		}

		return c.json({ ok: true, runs }, 202);
	});

	return app;
}
