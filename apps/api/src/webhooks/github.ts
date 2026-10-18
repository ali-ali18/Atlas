import { Hono, type Context } from "hono";
import type { RoutineQueue } from "@workspace/queue";
import {
	enrichGithubEvent,
	ensureGithubRepoHook,
	getGithubToken,
	getGithubWebhookSecret,
	loadGithubAppCredentials,
	openSecrets,
} from "@workspace/agent-runtime";
import {
	deleteRoutine,
	findCoveringGithubInstallation,
	findGithubRoutineByLegacyHookKey,
	hasOverlappingRoutineRun,
	markRoutinePendingDelete,
	updateRoutineGithubState,
} from "@workspace/db";
import {
	githubEventMatchesTrigger,
	type GithubWebhookTrigger,
	type NormalizedGithubEvent,
} from "@workspace/shared";
import type { EventEnvelope } from "@workspace/shared";
import { toEnvelopeGithub } from "./normalize.js";
import {
	enqueueMatchedRoutineEvents,
	matchGithubHookRoutines,
	verifyGithubSignature,
	type MatchedGithubHookRoutine,
} from "./dispatch.js";

/** 1 MB — payload de webhook do GitHub pode ter dezenas de commits. */
const MAX_BODY_BYTES = 1_048_576;

/** Formato selado (sealSecrets/openSecrets) do secret legado por-rotina (compat). */
type LegacyGithubTriggerSecrets = { webhookSecret: string };

/** Dependências injetáveis (testes passam dublês, sem precisar mockar módulo). */
export type GithubHookRouteDeps = {
	matchGithubHookRoutines: typeof matchGithubHookRoutines;
	enqueueMatchedRoutineEvents: typeof enqueueMatchedRoutineEvents;
	updateRoutineGithubState: typeof updateRoutineGithubState;
	markRoutinePendingDelete: typeof markRoutinePendingDelete;
	hasOverlappingRoutineRun: typeof hasOverlappingRoutineRun;
	deleteRoutine: typeof deleteRoutine;
	ensureRepoHook: typeof ensureGithubRepoHook;
	findLegacyByHookKey: typeof findGithubRoutineByLegacyHookKey;
	/** `getGithubWebhookSecret()` — derivado de CONNECTOR_ENCRYPTION_KEY (injetável pra teste). */
	webhookSecret: () => string | undefined;
	/**
	 * O GitHub App cobre este repo para este usuário? Então o evento chega (e é enriquecido) pelo
	 * webhook do app e o hook por-repo antigo é ignorado, evitando disparo duplicado.
	 */
	isCoveredByApp?: (userId: string, repo: string) => Promise<boolean>;
	/** Enriquece o evento (lista completa de commits etc.) com o token do usuário; best-effort. */
	enrichEvent?: (userId: string, event: NormalizedGithubEvent, payload: Record<string, unknown>) => Promise<NormalizedGithubEvent>;
};

export const DEFAULT_GITHUB_HOOK_ROUTE_DEPS: GithubHookRouteDeps = {
	matchGithubHookRoutines,
	enqueueMatchedRoutineEvents,
	updateRoutineGithubState,
	markRoutinePendingDelete,
	hasOverlappingRoutineRun,
	deleteRoutine,
	ensureRepoHook: ensureGithubRepoHook,
	findLegacyByHookKey: findGithubRoutineByLegacyHookKey,
	webhookSecret: () => getGithubWebhookSecret(),
	isCoveredByApp: async (userId, repo) => {
		if (!(await loadGithubAppCredentials())) return false;
		return (await findCoveringGithubInstallation(userId, repo)) !== null;
	},
	enrichEvent: async (userId, event, payload) => {
		const auth = await getGithubToken(userId, { repo: event.repo });
		if ("error" in auth) return event;
		return enrichGithubEvent({ event, payload, token: auth.token });
	},
};

export type PrBabysitterDecision = {
	/** `pr_merged`/`pr_closed` bate com o `prNumber` da babá — dispara o encerramento
	 * mesmo que o evento não esteja em `events` nem o autor passe em `users`. */
	matchesPr: boolean;
	/** Além de `matchesPr`, o evento também passa no matcher cheio (events/users) — roda a execução final. */
	shouldEnqueue: boolean;
};

/**
 * Babá de PR: um PR fechou (merged ou não) — decide se é hora de encerrar a
 * rotina, independente de `pr_merged`/`pr_closed` estarem selecionados em
 * `events` ou do autor passar no filtro `users` (o encerramento não é um
 * "evento disparável" normal, é limpeza).
 */
export function evaluatePrBabysitter(
	normalized: Pick<NormalizedGithubEvent, "type" | "repo" | "pr">,
	trigger: Pick<GithubWebhookTrigger, "repo" | "events" | "prNumber" | "users" | "branch">,
): PrBabysitterDecision {
	const isCloseEvent = normalized.type === "pr_merged" || normalized.type === "pr_closed";
	const matchesPr =
		trigger.prNumber !== undefined &&
		isCloseEvent &&
		normalized.repo.toLowerCase() === trigger.repo.toLowerCase() &&
		normalized.pr?.number === trigger.prNumber;
	return {
		matchesPr,
		shouldEnqueue: matchesPr && githubEventMatchesTrigger(normalized as NormalizedGithubEvent, trigger),
	};
}

/**
 * Webhook do GitHub (gatilho de rotina — distinto do conector MCP GitHub que
 * o bot usa como ferramenta). Endpoint ÚNICO e fixo (`/v1/hooks/github`),
 * secret compartilhado (`GITHUB_WEBHOOK_SECRET`, todo o install) — sem
 * hook/secret por rotina. O caminho antigo `/v1/hooks/github/:hookKey`
 * (rotinas criadas por uma versão anterior) continua aceito: primeiro tenta o
 * secret compartilhado; se não bater, cai pro secret legado por-rotina (só
 * leitura, nunca regrava). Assinatura HMAC-SHA256 sobre o body cru
 * (`X-Hub-Signature-256`), nunca confia em `Content-Type`. Idempotência por
 * `X-GitHub-Delivery` (`enqueueMatchedRoutineEvents` já dedupa). Roteamento
 * pelo `repo` do payload (não pela URL) — várias rotinas/usuários podem
 * assinar o mesmo repo.
 */
export function createGithubHookRoutes(
	routineQueue: RoutineQueue | null,
	deps: GithubHookRouteDeps = DEFAULT_GITHUB_HOOK_ROUTE_DEPS,
) {
	const app = new Hono();

	const handler = async (c: Context) => {
		const hookKeyParam = c.req.param("hookKey")?.trim();

		const githubEvent = c.req.header("X-GitHub-Event")?.trim();
		if (!githubEvent) return c.json({ error: "Missing X-GitHub-Event" }, 400);

		// Ping do "Adicionar webhook" no GitHub: responde antes de qualquer
		// checagem de fila/secret pra confirmar a URL rapidamente.
		if (githubEvent === "ping") {
			return c.json({ ok: true }, 200);
		}

		if (!routineQueue) {
			return c.json({ error: "Fila de rotinas indisponível" }, 503);
		}

		const sharedSecret = deps.webhookSecret();
		if (!sharedSecret) {
			console.error(
				"Secret do webhook do GitHub indisponível (CONNECTOR_ENCRYPTION_KEY ausente/inválida) — webhook rejeitado (503)",
			);
			return c.json(
				{ error: "Webhook do GitHub não configurado (CONNECTOR_ENCRYPTION_KEY)" },
				503,
			);
		}

		const rawBody = await c.req.text();
		if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
			return c.json({ error: "Payload too large" }, 413);
		}

		const signature = c.req.header("X-Hub-Signature-256");
		let authenticated = verifyGithubSignature(sharedSecret, rawBody, signature);
		// Quando autenticado só pelo secret legado por-rotina (não pelo
		// compartilhado), o roteamento NÃO pode confiar no `repo` do payload pra
		// achar outras rotinas/usuários — quem detém esse secret só provou
		// controlar AQUELA rotina, não o install inteiro. `legacyMatch` restringe
		// o roteamento a ela (e só se o repo do payload bater com o dela).
		let legacyMatch: Awaited<ReturnType<typeof deps.findLegacyByHookKey>> = null;

		if (!authenticated && hookKeyParam) {
			// Compat: hook cadastrado por uma versão anterior (secret por-rotina).
			const legacy = await deps.findLegacyByHookKey(hookKeyParam);
			if (legacy) {
				try {
					const secrets = openSecrets<LegacyGithubTriggerSecrets>(legacy.legacySecretEnc);
					if (verifyGithubSignature(secrets.webhookSecret, rawBody, signature)) {
						authenticated = true;
						legacyMatch = legacy;
					}
				} catch {
					authenticated = false;
				}
			}
		}

		if (!authenticated) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		let payload: unknown;
		try {
			payload = rawBody.trim() ? JSON.parse(rawBody) : {};
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		if (!payload || typeof payload !== "object") {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const body = payload as Record<string, unknown>;

		// Só o secret compartilhado autoriza roteamento pelo `repo` do payload
		// através de todas as rotinas/usuários. Autenticado só pelo secret legado
		// por-rotina: restringe a ESSA rotina, e só se o repo dela bater com o do
		// payload (senão o dono do secret legado poderia forjar `repository.full_name`
		// pra alcançar rotinas de outros repos/usuários).
		const repo = githubPayloadRepo(body);
		if (!repo) return c.json({ ok: true, ignored: true }, 202);
		let matches: MatchedGithubHookRoutine[] = legacyMatch
			? legacyMatch.routine.github &&
				legacyMatch.routine.github.repo.toLowerCase() === repo.toLowerCase()
				? [{ routine: legacyMatch.routine, trigger: legacyMatch.routine.github }]
				: []
			: await deps.matchGithubHookRoutines(repo);

		// Repo coberto pelo GitHub App do dono da rotina: o evento vem (enriquecido) pelo
		// webhook do app; este hook por-repo antigo é ignorado pra não disparar duas vezes.
		if (deps.isCoveredByApp) {
			const covered = new Map<string, boolean>();
			const keep: MatchedGithubHookRoutine[] = [];
			for (const match of matches) {
				const userId = match.routine.userId;
				if (!covered.has(userId)) {
					covered.set(userId, await deps.isCoveredByApp(userId, repo).catch(() => false));
				}
				if (!covered.get(userId)) keep.push(match);
			}
			matches = keep;
		}

		const result = await routeGithubEvent({
			routineQueue,
			deps,
			githubEvent,
			deliveryId: c.req.header("X-GitHub-Delivery"),
			body,
			rawBody,
			repo,
			matches,
		});
		return c.json(result.body, result.status);
	};

	app.post("/v1/hooks/github", handler);
	app.post("/v1/hooks/github/:hookKey", handler);

	return app;
}

/** `repository.full_name` do payload (vazio quando o evento não é de repositório). */
export function githubPayloadRepo(body: Record<string, unknown>): string {
	const repository =
		body.repository && typeof body.repository === "object" ? (body.repository as Record<string, unknown>) : {};
	return typeof repository.full_name === "string" ? repository.full_name : "";
}

/** Push de branch deletada ou de tag nunca dispara rotina. */
export function isIgnoredGithubPush(githubEvent: string, body: Record<string, unknown>): boolean {
	if (githubEvent !== "push") return false;
	const ref = typeof body.ref === "string" ? body.ref : "";
	return body.deleted === true || (ref !== "" && !ref.startsWith("refs/heads/"));
}

export type RouteGithubEventInput = {
	routineQueue: RoutineQueue;
	deps: GithubHookRouteDeps;
	githubEvent: string;
	deliveryId: string | undefined;
	body: Record<string, unknown>;
	rawBody: string;
	repo: string;
	matches: MatchedGithubHookRoutine[];
};

export type RouteGithubEventResult = { status: 202 | 503; body: Record<string, unknown> };

/**
 * Parte comum dos dois webhooks (hook por-repo legado e GitHub App): marca o webhook como vivo,
 * normaliza, confere gatilho/babá de PR, enriquece (uma vez por usuário) e enfileira.
 */
export async function routeGithubEvent(input: RouteGithubEventInput): Promise<RouteGithubEventResult> {
	const { routineQueue, deps, githubEvent, deliveryId, body, rawBody, matches } = input;
	if (isIgnoredGithubPush(githubEvent, body)) return { status: 202, body: { ok: true, ignored: true } };

	// Entrega assinada e válida: marca o webhook como "vivo" pra cada rotina deste repo, mesmo
	// que o evento acabe sendo ignorado abaixo.
	const nowIso = new Date().toISOString();
	await Promise.all(
		matches.map((match) => deps.updateRoutineGithubState(match.routine.id, { lastWebhookAt: nowIso })),
	);

	const envelope = toEnvelopeGithub({ githubEvent, deliveryId, payload: body, rawBody });
	if (!envelope) {
		// Evento não coberto pelo vocabulário atual (star, fork, watch…): aceita, não dispara.
		return { status: 202, body: { ok: true, ignored: true } };
	}
	const normalizedEvent = envelope.payload as NormalizedGithubEvent;

	const runnable: MatchedGithubHookRoutine[] = [];
	for (const match of matches) {
		const normalMatch = githubEventMatchesTrigger(normalizedEvent, match.trigger);
		if (normalMatch) runnable.push(match);

		const babysitter = evaluatePrBabysitter(normalizedEvent, match.trigger);
		if (!babysitter.matchesPr) continue;

		// Babá de PR: o PR fechou (merged ou não) — encerra a rotina
		// independente de o evento estar selecionado ou do filtro `users`.
		await deps.markRoutinePendingDelete(match.routine.id);
		if (!normalMatch) {
			// Não vai rodar execução final: sem run ativo, já apaga de vez.
			const hasActive = await deps.hasOverlappingRoutineRun(match.routine.id);
			if (!hasActive) {
				await deps.deleteRoutine(match.routine.userId, match.routine.botId, match.routine.id);
			}
		}
		// Recalcula o hook único do repo — a união de eventos das rotinas
		// deste usuário pode ter encolhido (ou some, se não sobrou nenhuma).
		await deps
			.ensureRepoHook({ userId: match.routine.userId, repo: match.trigger.repo })
			.catch(() => undefined);
	}

	if (runnable.length === 0) return { status: 202, body: { ok: true, ignored: true } };

	// Enriquece uma vez por usuário (token dele) e enfileira cada grupo com o seu envelope.
	const byUser = new Map<string, MatchedGithubHookRoutine[]>();
	for (const match of runnable) {
		const group = byUser.get(match.routine.userId) ?? [];
		group.push(match);
		byUser.set(match.routine.userId, group);
	}
	const runs: Array<{ routineId: string; routineRunId: string }> = [];
	for (const [userId, group] of byUser) {
		let userEnvelope: EventEnvelope = envelope;
		if (deps.enrichEvent) {
			const enriched = await deps.enrichEvent(userId, normalizedEvent, body).catch(() => normalizedEvent);
			if (enriched !== normalizedEvent) userEnvelope = { ...envelope, payload: enriched };
		}
		runs.push(
			...(await deps.enqueueMatchedRoutineEvents(
				routineQueue,
				group.map((match) => ({ routine: match.routine })),
				userEnvelope,
			)),
		);
	}
	if (runs.length === 0) return { status: 503, body: { error: "Failed to enqueue" } };
	return { status: 202, body: { ok: true, runs } };
}
