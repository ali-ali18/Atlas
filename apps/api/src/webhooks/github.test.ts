import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { sealSecrets } from "@workspace/agent-runtime";
import type { RoutineQueue } from "@workspace/queue";
import type { GithubWebhookTrigger, RoutineRecord } from "@workspace/shared";
import {
	createGithubHookRoutes,
	evaluatePrBabysitter,
	type GithubHookRouteDeps,
} from "./github.js";

const ENCRYPTION_KEY = Buffer.alloc(32, 3);
process.env.CONNECTOR_ENCRYPTION_KEY = ENCRYPTION_KEY.toString("base64");

const WEBHOOK_SECRET = "shared-install-secret";
const LEGACY_SECRET = "legacy-per-routine-secret";
const LEGACY_SECRET_ENC = sealSecrets({ webhookSecret: LEGACY_SECRET }, ENCRYPTION_KEY);

function signWith(secret: string, body: string): string {
	return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function sign(body: string): string {
	return signWith(WEBHOOK_SECRET, body);
}

function makeRoutine(overrides: Partial<RoutineRecord> = {}): RoutineRecord {
	return {
		id: "routine-1",
		userId: "user-1",
		botId: "bot-1",
		conversationId: null,
		name: "Babá de PR",
		prompt: "revise o PR",
		model: "gpt",
		enabled: true,
		triggerType: "event",
		schedule: null,
		timezone: "America/Sao_Paulo",
		triggerJson: null,
		lastRunAt: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function makeTrigger(overrides: Partial<GithubWebhookTrigger> = {}): GithubWebhookTrigger {
	return {
		kind: "github",
		repo: "acme/site",
		events: ["pr_approved"],
		...overrides,
	};
}

type Deps = GithubHookRouteDeps & {
	calls: {
		updateRoutineGithubState: unknown[][];
		enqueueMatchedRoutineEvents: unknown[][];
		markRoutinePendingDelete: unknown[][];
		hasOverlappingRoutineRun: unknown[][];
		deleteRoutine: unknown[][];
		ensureRepoHook: unknown[][];
		matchGithubHookRoutines: unknown[][];
	};
};

function fakeDeps(
	matches: Array<{ routine: RoutineRecord; trigger: GithubWebhookTrigger }>,
	overrides: Partial<GithubHookRouteDeps> = {},
): Deps {
	const calls: Deps["calls"] = {
		updateRoutineGithubState: [],
		enqueueMatchedRoutineEvents: [],
		markRoutinePendingDelete: [],
		hasOverlappingRoutineRun: [],
		deleteRoutine: [],
		ensureRepoHook: [],
		matchGithubHookRoutines: [],
	};
	const deps: Deps = {
		calls,
		matchGithubHookRoutines: (async (...args: unknown[]) => {
			calls.matchGithubHookRoutines.push(args);
			return matches;
		}) as GithubHookRouteDeps["matchGithubHookRoutines"],
		enqueueMatchedRoutineEvents: (async (...args: unknown[]) => {
			calls.enqueueMatchedRoutineEvents.push(args);
			const routines = args[1] as Array<{ routine: RoutineRecord }>;
			return routines.map((r) => ({ routineId: r.routine.id, routineRunId: `run-${r.routine.id}` }));
		}) as GithubHookRouteDeps["enqueueMatchedRoutineEvents"],
		updateRoutineGithubState: (async (...args: unknown[]) => {
			calls.updateRoutineGithubState.push(args);
		}) as GithubHookRouteDeps["updateRoutineGithubState"],
		markRoutinePendingDelete: (async (...args: unknown[]) => {
			calls.markRoutinePendingDelete.push(args);
		}) as GithubHookRouteDeps["markRoutinePendingDelete"],
		hasOverlappingRoutineRun: (async (...args: unknown[]) => {
			calls.hasOverlappingRoutineRun.push(args);
			return false;
		}) as GithubHookRouteDeps["hasOverlappingRoutineRun"],
		deleteRoutine: (async (...args: unknown[]) => {
			calls.deleteRoutine.push(args);
			return true;
		}) as GithubHookRouteDeps["deleteRoutine"],
		ensureRepoHook: (async (...args: unknown[]) => {
			calls.ensureRepoHook.push(args);
			return { ok: true };
		}) as GithubHookRouteDeps["ensureRepoHook"],
		findLegacyByHookKey: (async () => null) as GithubHookRouteDeps["findLegacyByHookKey"],
		webhookSecret: () => WEBHOOK_SECRET,
		...overrides,
	};
	return deps;
}

const FAKE_QUEUE = {} as RoutineQueue;

function postWebhook(
	app: ReturnType<typeof createGithubHookRoutes>,
	input: { githubEvent: string; payload: unknown; deliveryId?: string; path?: string; signature?: string },
) {
	const body = JSON.stringify(input.payload);
	return app.request(input.path ?? "/v1/hooks/github", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"X-GitHub-Event": input.githubEvent,
			"X-Hub-Signature-256": input.signature ?? sign(body),
			...(input.deliveryId ? { "X-GitHub-Delivery": input.deliveryId } : {}),
		},
		body,
	});
}

test("evaluatePrBabysitter: pr_merged bate com prNumber mesmo fora de events/users", () => {
	const trigger: Pick<GithubWebhookTrigger, "repo" | "events" | "prNumber" | "users" | "branch"> = { repo: "acme/site", events: ["pr_approved"], prNumber: 7, users: ["outra-pessoa"], branch: undefined };
	const normalized = { type: "pr_merged" as const, repo: "acme/site", pr: { number: 7, title: "x" } };
	const decision = evaluatePrBabysitter(normalized, trigger);
	assert.equal(decision.matchesPr, true);
	assert.equal(decision.shouldEnqueue, false); // pr_merged não está em events
});

test("evaluatePrBabysitter: pr_closed com prNumber diferente não bate", () => {
	const trigger: Pick<GithubWebhookTrigger, "repo" | "events" | "prNumber" | "users" | "branch"> = { repo: "acme/site", events: ["pr_approved"], prNumber: 7, users: undefined, branch: undefined };
	const normalized = { type: "pr_closed" as const, repo: "acme/site", pr: { number: 9, title: "x" } };
	assert.equal(evaluatePrBabysitter(normalized, trigger).matchesPr, false);
});

test("evaluatePrBabysitter: sem prNumber configurado nunca aciona a babá", () => {
	const trigger: Pick<GithubWebhookTrigger, "repo" | "events" | "prNumber" | "users" | "branch"> = { repo: "acme/site", events: ["pr_merged"], prNumber: undefined, users: undefined, branch: undefined };
	const normalized = { type: "pr_merged" as const, repo: "acme/site", pr: { number: 1, title: "x" } };
	assert.equal(evaluatePrBabysitter(normalized, trigger).matchesPr, false);
});

test("evaluatePrBabysitter: evento selecionado + prNumber bate -> shouldEnqueue também true", () => {
	const trigger: Pick<GithubWebhookTrigger, "repo" | "events" | "prNumber" | "users" | "branch"> = { repo: "acme/site", events: ["pr_merged"], prNumber: 7, users: undefined, branch: undefined };
	const normalized = { type: "pr_merged" as const, repo: "acme/site", pr: { number: 7, title: "x" } };
	const decision = evaluatePrBabysitter(normalized, trigger);
	assert.equal(decision.matchesPr, true);
	assert.equal(decision.shouldEnqueue, true);
});

test("webhook: secret indisponível (CONNECTOR_ENCRYPTION_KEY ausente) -> 503", async () => {
	const deps = fakeDeps([], { webhookSecret: () => undefined });
	const app = createGithubHookRoutes(FAKE_QUEUE, deps);
	const res = await postWebhook(app, { githubEvent: "pull_request", payload: { repository: { full_name: "acme/site" } } });
	assert.equal(res.status, 503);
});

test("webhook: ping responde 200 mesmo sem fila/secret", async () => {
	const deps = fakeDeps([], { webhookSecret: () => undefined });
	const app = createGithubHookRoutes(null, deps);
	const res = await app.request("/v1/hooks/github", {
		method: "POST",
		headers: { "X-GitHub-Event": "ping" },
		body: "{}",
	});
	assert.equal(res.status, 200);
});

test("webhook (endpoint fixo, secret compartilhado): evento selecionado enfileira a execução, roteado por repo", async () => {
	const routine = makeRoutine();
	const trigger = makeTrigger({ events: ["pr_approved"] });
	const deps = fakeDeps([{ routine, trigger }]);
	const app = createGithubHookRoutes(FAKE_QUEUE, deps);

	const payload = {
		action: "submitted",
		repository: { full_name: "acme/site" },
		sender: { login: "ana" },
		review: { state: "approved", html_url: "https://x" },
		pull_request: { number: 7, title: "fix", user: { login: "ana" }, head: { ref: "h" }, base: { ref: "main" } },
	};
	const res = await postWebhook(app, { githubEvent: "pull_request_review", payload, deliveryId: "d1" });
	assert.equal(res.status, 202);
	const body = (await res.json()) as { ok: boolean; runs: unknown[] };
	assert.equal(body.ok, true);
	assert.equal(body.runs.length, 1);
	assert.equal(deps.calls.enqueueMatchedRoutineEvents.length, 1);
	assert.equal(deps.calls.markRoutinePendingDelete.length, 0);
});

test("webhook: assinatura inválida (secret compartilhado errado, sem hookKey legado) devolve 401 e não enfileira nada", async () => {
	const routine = makeRoutine();
	const trigger = makeTrigger({ events: ["pr_approved"] });
	const deps = fakeDeps([{ routine, trigger }]);
	const app = createGithubHookRoutes(FAKE_QUEUE, deps);

	const payload = { action: "submitted", repository: { full_name: "acme/site" } };
	const res = await postWebhook(app, {
		githubEvent: "pull_request_review",
		payload,
		signature: "sha256=deadbeef",
	});
	assert.equal(res.status, 401);
	assert.equal(deps.calls.enqueueMatchedRoutineEvents.length, 0);
});

test("webhook legado (/v1/hooks/github/:hookKey): secret compartilhado não bate, mas o secret legado por-rotina bate -> autoriza (só essa rotina, repo bate)", async () => {
	const trigger = makeTrigger({ events: ["pr_approved"] });
	// `routine.github` precisa refletir o próprio trigger dessa rotina — é
	// contra ELE (não contra `matchGithubHookRoutines`) que o repo do payload
	// é comparado quando a autenticação é só pelo secret legado.
	const routine = makeRoutine({ github: trigger });
	const deps = fakeDeps([{ routine, trigger }], {
		findLegacyByHookKey: (async (hookKey: string) =>
			hookKey === "hk1" ? { routine, legacySecretEnc: LEGACY_SECRET_ENC } : null) as GithubHookRouteDeps["findLegacyByHookKey"],
	});
	const app = createGithubHookRoutes(FAKE_QUEUE, deps);

	const payload = {
		action: "submitted",
		repository: { full_name: "acme/site" },
		review: { state: "approved" },
		pull_request: { number: 7, title: "fix" },
	};
	const body = JSON.stringify(payload);
	const res = await app.request("/v1/hooks/github/hk1", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"X-GitHub-Event": "pull_request_review",
			// Assinado com o secret LEGADO, não com o compartilhado.
			"X-Hub-Signature-256": signWith(LEGACY_SECRET, body),
		},
		body,
	});
	assert.equal(res.status, 202);
	assert.equal(deps.calls.enqueueMatchedRoutineEvents.length, 1);
	// Autenticado só pelo secret legado: NUNCA cai pro roteamento repo-wide.
	assert.equal(deps.calls.matchGithubHookRoutines.length, 0);
});

test("segurança: autenticado só pelo secret legado, payload alega OUTRO repo -> não roteia pra outras rotinas/usuários", async () => {
	// A rotina do secret legado é de "acme/site". O payload (assinado com o
	// secret legado de "acme/site") alega `repository.full_name` = repo de
	// OUTRO usuário — não pode alcançar a rotina alheia via `matchGithubHookRoutines`.
	const legacyTrigger = makeTrigger({ repo: "acme/site", events: ["pr_approved"] });
	const legacyRoutine = makeRoutine({ id: "routine-legacy", userId: "user-1", github: legacyTrigger });
	const otherTrigger = makeTrigger({ repo: "other-user/other-repo", events: ["pr_approved"] });
	const otherRoutine = makeRoutine({ id: "routine-other", userId: "user-2" });
	const deps = fakeDeps([{ routine: otherRoutine, trigger: otherTrigger }], {
		findLegacyByHookKey: (async (hookKey: string) =>
			hookKey === "hk1"
				? { routine: legacyRoutine, legacySecretEnc: LEGACY_SECRET_ENC }
				: null) as GithubHookRouteDeps["findLegacyByHookKey"],
	});
	const app = createGithubHookRoutes(FAKE_QUEUE, deps);

	const payload = {
		action: "submitted",
		// Repo forjado: não é o repo registrado na rotina do secret legado.
		repository: { full_name: "other-user/other-repo" },
		review: { state: "approved" },
		pull_request: { number: 7, title: "fix" },
	};
	const body = JSON.stringify(payload);
	const res = await app.request("/v1/hooks/github/hk1", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"X-GitHub-Event": "pull_request_review",
			"X-Hub-Signature-256": signWith(LEGACY_SECRET, body),
		},
		body,
	});
	// Autenticado (o secret legado bateu), mas nada casa: a rotina do payload
	// forjado nunca é alcançada, e o roteamento repo-wide nunca é chamado.
	assert.equal(res.status, 202);
	const responseBody = (await res.json()) as { ok: boolean; ignored?: boolean };
	assert.equal(responseBody.ignored, true);
	assert.equal(deps.calls.enqueueMatchedRoutineEvents.length, 0);
	assert.equal(deps.calls.matchGithubHookRoutines.length, 0);
	assert.equal(deps.calls.markRoutinePendingDelete.length, 0);
});

test("webhook legado: hookKey desconhecido e secret compartilhado errado -> 401", async () => {
	const routine = makeRoutine();
	const trigger = makeTrigger({ events: ["pr_approved"] });
	const deps = fakeDeps([{ routine, trigger }]);
	const app = createGithubHookRoutes(FAKE_QUEUE, deps);

	const payload = { action: "submitted", repository: { full_name: "acme/site" } };
	const body = JSON.stringify(payload);
	const res = await app.request("/v1/hooks/github/hk-desconhecido", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"X-GitHub-Event": "pull_request_review",
			"X-Hub-Signature-256": "sha256=deadbeef",
		},
		body,
	});
	assert.equal(res.status, 401);
});

test("babá de PR: PR mesclado fora de events e sem run ativo apaga a rotina na hora e reconcilia o hook do repo", async () => {
	const routine = makeRoutine();
	const trigger = makeTrigger({ events: ["pr_approved"], prNumber: 7 });
	const deps = fakeDeps([{ routine, trigger }]);
	const app = createGithubHookRoutes(FAKE_QUEUE, deps);

	const payload = {
		action: "closed",
		repository: { full_name: "acme/site" },
		sender: { login: "ana" },
		pull_request: { number: 7, title: "fix", merged: true, user: { login: "ana" }, head: { ref: "h" }, base: { ref: "main" } },
	};
	const res = await postWebhook(app, { githubEvent: "pull_request", payload, deliveryId: "d2" });
	assert.equal(res.status, 202);
	// pr_merged não está selecionado -> não enfileira execução alguma.
	assert.equal(deps.calls.enqueueMatchedRoutineEvents.length, 0);
	// mas a babá encerra a rotina: pendingDelete e (sem run ativo) apaga na hora.
	assert.equal(deps.calls.markRoutinePendingDelete.length, 1);
	assert.deepEqual(deps.calls.markRoutinePendingDelete[0], ["routine-1"]);
	assert.equal(deps.calls.hasOverlappingRoutineRun.length, 1);
	assert.equal(deps.calls.deleteRoutine.length, 1);
	assert.deepEqual(deps.calls.deleteRoutine[0], ["user-1", "bot-1", "routine-1"]);
	// Recalcula o hook único do repo pra esta rotina não contar mais na união.
	assert.equal(deps.calls.ensureRepoHook.length, 1);
	assert.deepEqual(deps.calls.ensureRepoHook[0], [{ userId: "user-1", repo: "acme/site" }]);
});

test("babá de PR: PR mesclado com run ativo não apaga a rotina na hora (só marca pendingDelete)", async () => {
	const routine = makeRoutine();
	const trigger = makeTrigger({ events: ["pr_approved"], prNumber: 7 });
	const deps = fakeDeps([{ routine, trigger }], {
		hasOverlappingRoutineRun: (async () => true) as GithubHookRouteDeps["hasOverlappingRoutineRun"],
	});
	const app = createGithubHookRoutes(FAKE_QUEUE, deps);

	const payload = {
		action: "closed",
		repository: { full_name: "acme/site" },
		pull_request: { number: 7, title: "fix", merged: true, head: { ref: "h" }, base: { ref: "main" } },
	};
	await postWebhook(app, { githubEvent: "pull_request", payload, deliveryId: "d3" });
	assert.equal(deps.calls.markRoutinePendingDelete.length, 1);
	assert.equal(deps.calls.deleteRoutine.length, 0);
});

test("babá de PR: pr_merged selecionado em events -> enfileira e marca pendingDelete, não apaga na hora", async () => {
	const routine = makeRoutine();
	const trigger = makeTrigger({ events: ["pr_merged"], prNumber: 7 });
	const deps = fakeDeps([{ routine, trigger }]);
	const app = createGithubHookRoutes(FAKE_QUEUE, deps);

	const payload = {
		action: "closed",
		repository: { full_name: "acme/site" },
		pull_request: { number: 7, title: "fix", merged: true, head: { ref: "h" }, base: { ref: "main" } },
	};
	const res = await postWebhook(app, { githubEvent: "pull_request", payload, deliveryId: "d4" });
	assert.equal(res.status, 202);
	assert.equal(deps.calls.enqueueMatchedRoutineEvents.length, 1);
	assert.equal(deps.calls.markRoutinePendingDelete.length, 1);
	// evento foi selecionado -> não é o caso "apaga na hora" (o worker cuida disso depois do run).
	assert.equal(deps.calls.deleteRoutine.length, 0);
});

test("push com deleted:true nunca dispara rotina (guard roda antes do match)", async () => {
	const routine = makeRoutine();
	const trigger = makeTrigger({ events: ["push"] });
	const deps = fakeDeps([{ routine, trigger }]);
	const app = createGithubHookRoutes(FAKE_QUEUE, deps);

	const payload = { ref: "refs/heads/feature-x", deleted: true, repository: { full_name: "acme/site" } };
	const res = await postWebhook(app, { githubEvent: "push", payload, deliveryId: "d5" });
	assert.equal(res.status, 202);
	assert.equal(deps.calls.enqueueMatchedRoutineEvents.length, 0);
	assert.equal(deps.calls.updateRoutineGithubState.length, 0);
});

test("push de tag (refs/tags/…) nunca dispara rotina (guard roda antes do match)", async () => {
	const routine = makeRoutine();
	const trigger = makeTrigger({ events: ["push"] });
	const deps = fakeDeps([{ routine, trigger }]);
	const app = createGithubHookRoutes(FAKE_QUEUE, deps);

	const payload = { ref: "refs/tags/v1.0.0", after: "abc", repository: { full_name: "acme/site" } };
	const res = await postWebhook(app, { githubEvent: "push", payload, deliveryId: "d6" });
	assert.equal(res.status, 202);
	assert.equal(deps.calls.enqueueMatchedRoutineEvents.length, 0);
	assert.equal(deps.calls.updateRoutineGithubState.length, 0);
});

test("push numa branch de verdade: casa o trigger (sem branch configurada) e enfileira", async () => {
	const routine = makeRoutine();
	const trigger = makeTrigger({ events: ["push"] });
	const deps = fakeDeps([{ routine, trigger }]);
	const app = createGithubHookRoutes(FAKE_QUEUE, deps);

	const payload = {
		ref: "refs/heads/main",
		after: "deadbeef",
		commits: [{}, {}],
		repository: { full_name: "acme/site" },
		pusher: { name: "ana" },
	};
	const res = await postWebhook(app, { githubEvent: "push", payload, deliveryId: "d7" });
	assert.equal(res.status, 202);
	assert.equal(deps.calls.enqueueMatchedRoutineEvents.length, 1);
});

test("push com branch configurada no trigger: só enfileira quando a branch do push bate", async () => {
	const routine = makeRoutine();
	const trigger = makeTrigger({ events: ["push"], branch: "main" });
	const deps = fakeDeps([{ routine, trigger }]);
	const app = createGithubHookRoutes(FAKE_QUEUE, deps);

	const noMatch = await postWebhook(app, {
		githubEvent: "push",
		payload: {
			ref: "refs/heads/dev",
			after: "abc",
			repository: { full_name: "acme/site" },
		},
		deliveryId: "d8",
	});
	assert.equal(noMatch.status, 202);
	assert.equal(deps.calls.enqueueMatchedRoutineEvents.length, 0);

	const match = await postWebhook(app, {
		githubEvent: "push",
		payload: {
			ref: "refs/heads/main",
			after: "abc",
			repository: { full_name: "acme/site" },
		},
		deliveryId: "d9",
	});
	assert.equal(match.status, 202);
	assert.equal(deps.calls.enqueueMatchedRoutineEvents.length, 1);
});
