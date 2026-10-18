import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import type { RoutineQueue } from "@workspace/queue";
import type { GithubWebhookTrigger, NormalizedGithubEvent, RoutineRecord } from "@workspace/shared";
import type { GithubInstallationRecord } from "@workspace/db";
import { createGithubAppWebhookRoutes, type DEFAULT_GITHUB_APP_WEBHOOK_DEPS } from "./github-app.js";
import { createGithubHookRoutes, type GithubHookRouteDeps } from "./github.js";

type AppDeps = typeof DEFAULT_GITHUB_APP_WEBHOOK_DEPS;

const SECRET = "app-webhook-secret";
const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
const FAKE_QUEUE = {} as RoutineQueue;

function routine(id: string, userId: string): RoutineRecord {
	return {
		id,
		userId,
		botId: "bot-1",
		conversationId: null,
		name: "Push",
		prompt: "resuma",
		model: "m",
		enabled: true,
		triggerType: "event",
		schedule: null,
		timezone: "America/Sao_Paulo",
		triggerJson: null,
		lastRunAt: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	} as RoutineRecord;
}

const trigger: GithubWebhookTrigger = { kind: "github", repo: "acme/site", events: ["push"] };

function installation(over: Partial<GithubInstallationRecord> = {}): GithubInstallationRecord {
	return {
		id: "inst-row",
		userId: "user-1",
		installationId: "555",
		accountLogin: "acme",
		accountType: "Organization",
		repositorySelection: "selected",
		repositories: [{ fullName: "acme/site", private: false }],
		suspendedAt: null,
		createdAt: new Date(),
		...over,
	};
}

function setup(opts: { installs?: GithubInstallationRecord[]; routines?: RoutineRecord[] } = {}) {
	const installs = new Map((opts.installs ?? [installation()]).map((i) => [i.installationId, i]));
	const routines = opts.routines ?? [routine("r-user1", "user-1"), routine("r-user2", "user-2")];
	const seen = new Set<string>();
	const calls = {
		enqueued: [] as Array<{ routineIds: string[]; envelope: { payload: NormalizedGithubEvent } }>,
		updates: [] as Array<[string, unknown]>,
		deleted: [] as string[],
		forgotten: [] as string[],
		enrich: [] as string[],
	};
	const routineDeps = {
		matchGithubHookRoutines: async () => routines.map((r) => ({ routine: r, trigger })),
		enqueueMatchedRoutineEvents: async (_q: unknown, rs: Array<{ routine: RoutineRecord }>, envelope: unknown) => {
			calls.enqueued.push({ routineIds: rs.map((r) => r.routine.id), envelope: envelope as { payload: NormalizedGithubEvent } });
			return rs.map((r) => ({ routineId: r.routine.id, routineRunId: `run-${r.routine.id}` }));
		},
		updateRoutineGithubState: async () => undefined,
		markRoutinePendingDelete: async () => undefined,
		hasOverlappingRoutineRun: async () => false,
		deleteRoutine: async () => true,
		ensureRepoHook: async () => ({ ok: true }),
		findLegacyByHookKey: async () => null,
		webhookSecret: () => "legacy-shared",
		enrichEvent: async (userId: string, event: NormalizedGithubEvent) => {
			calls.enrich.push(userId);
			return { ...event, push: { ...event.push!, commits: 42, commitList: [{ sha: "abc1234", subject: "um" }] } };
		},
	} as unknown as GithubHookRouteDeps;
	const deps: AppDeps = {
		loadSecret: async () => SECRET,
		claimDelivery: async (id) => {
			if (seen.has(id)) return false;
			seen.add(id);
			return true;
		},
		releaseDelivery: async (id) => void seen.delete(id),
		getInstallation: async (id) => installs.get(id) ?? null,
		updateInstallation: async (id, patch) => {
			calls.updates.push([id, patch]);
			const cur = installs.get(id);
			if (cur) installs.set(id, { ...cur, ...patch } as GithubInstallationRecord);
			return true;
		},
		deleteInstallation: async (id) => {
			calls.deleted.push(id);
			return installs.delete(id);
		},
		forgetTokens: (id) => void calls.forgotten.push(id),
		routine: routineDeps,
	};
	return { app: createGithubAppWebhookRoutes(FAKE_QUEUE, deps), calls, installs, deps };
}

const pushPayload = {
	ref: "refs/heads/main",
	before: "a".repeat(40),
	after: "b".repeat(40),
	compare: "https://github.com/acme/site/compare/a...b",
	commits: [{ id: "1" }, { id: "2" }],
	pusher: { name: "ana" },
	repository: { full_name: "acme/site", default_branch: "main" },
	installation: { id: 555 },
};

function post(app: ReturnType<typeof setup>["app"], event: string, payload: unknown, extra: { delivery?: string; signature?: string } = {}) {
	const body = JSON.stringify(payload);
	return app.request("/v1/github-app/webhook", {
		method: "POST",
		headers: {
			"X-GitHub-Event": event,
			"X-Hub-Signature-256": extra.signature ?? sign(body),
			...(extra.delivery ? { "X-GitHub-Delivery": extra.delivery } : {}),
		},
		body,
	});
}

test("assinatura: inválida 401, ausente 401; ping assinado 200; app sem config 503", async () => {
	const { app } = setup();
	assert.equal((await post(app, "push", pushPayload, { signature: sign("x") })).status, 401);
	assert.equal((await post(app, "push", pushPayload, { signature: "" })).status, 401);
	assert.equal((await post(app, "ping", { zen: "x" })).status, 200);
	const { app: noApp } = (() => {
		const s = setup();
		const a = createGithubAppWebhookRoutes(FAKE_QUEUE, { ...s.deps, loadSecret: async () => undefined });
		return { app: a };
	})();
	assert.equal((await post(noApp as never, "push", pushPayload)).status, 503);
});

test("push de repo instalado dispara SÓ as rotinas do dono da instalação, com o evento enriquecido", async () => {
	const { app, calls } = setup();
	const res = await post(app, "push", pushPayload, { delivery: "d-1" });
	assert.equal(res.status, 202);
	assert.equal(calls.enqueued.length, 1);
	assert.deepEqual(calls.enqueued[0]!.routineIds, ["r-user1"]);
	const payload = calls.enqueued[0]!.envelope.payload;
	assert.equal(payload.push?.commits, 42);
	assert.equal(payload.push?.commitList?.length, 1);
	assert.deepEqual(calls.enrich, ["user-1"]);
});

test("entrega duplicada (mesmo X-GitHub-Delivery) é ignorada", async () => {
	const { app, calls } = setup();
	assert.equal((await post(app, "push", pushPayload, { delivery: "d-dup" })).status, 202);
	const again = await post(app, "push", pushPayload, { delivery: "d-dup" });
	assert.equal(again.status, 200);
	assert.equal(((await again.json()) as { duplicate?: boolean }).duplicate, true);
	assert.equal(calls.enqueued.length, 1);
});

test("instalação desconhecida, suspensa ou evento de tag não dispara nada", async () => {
	const { app, calls } = setup({ installs: [installation({ suspendedAt: new Date() })] });
	assert.equal((await post(app, "push", pushPayload, { delivery: "s1" })).status, 202);
	assert.equal((await post(app, "push", { ...pushPayload, installation: { id: 999 } }, { delivery: "s2" })).status, 202);
	const { app: ok, calls: okCalls } = setup();
	assert.equal((await post(ok, "push", { ...pushPayload, ref: "refs/tags/v1" }, { delivery: "s3" })).status, 202);
	assert.equal(calls.enqueued.length + okCalls.enqueued.length, 0);
});

test("installation: deleted apaga a instalação; suspend/unsuspend atualizam; desconhecida é ignorada", async () => {
	const { app, calls, installs } = setup();
	await post(app, "installation", { action: "suspend", installation: { id: 555 } }, { delivery: "i1" });
	assert.ok((calls.updates[0]![1] as { suspendedAt: Date }).suspendedAt instanceof Date);
	await post(app, "installation", { action: "unsuspend", installation: { id: 555 } }, { delivery: "i2" });
	assert.equal((calls.updates[1]![1] as { suspendedAt: unknown }).suspendedAt, null);
	await post(app, "installation", { action: "deleted", installation: { id: 555 } }, { delivery: "i3" });
	assert.deepEqual(calls.deleted, ["555"]);
	assert.equal(installs.has("555"), false);
	assert.ok(calls.forgotten.includes("555"));
	const before = calls.updates.length;
	await post(app, "installation", { action: "suspend", installation: { id: 123 } }, { delivery: "i4" });
	assert.equal(calls.updates.length, before);
});

test("installation_repositories: adicionados entram, removidos saem; 'all' zera a lista", async () => {
	const { app, installs } = setup();
	await post(
		app,
		"installation_repositories",
		{
			action: "added",
			installation: { id: 555 },
			repository_selection: "selected",
			repositories_added: [{ full_name: "acme/novo", private: true }],
			repositories_removed: [{ full_name: "acme/site" }],
		},
		{ delivery: "r1" },
	);
	assert.deepEqual(installs.get("555")!.repositories, [{ fullName: "acme/novo", private: true }]);
	await post(app, "installation_repositories", { action: "added", installation: { id: 555 }, repository_selection: "all" }, { delivery: "r2" });
	assert.equal(installs.get("555")!.repositorySelection, "all");
	assert.equal(installs.get("555")!.repositories, null);
});

test("hook por-repo antigo é ignorado quando o app cobre o repo do usuário (sem disparo duplicado)", async () => {
	const { calls, deps } = setup();
	const legacy = createGithubHookRoutes(FAKE_QUEUE, {
		...deps.routine,
		webhookSecret: () => "legacy-shared",
		isCoveredByApp: async (userId) => userId === "user-1",
	});
	const body = JSON.stringify({ ...pushPayload, installation: undefined });
	const res = await legacy.request("/v1/hooks/github", {
		method: "POST",
		headers: { "X-GitHub-Event": "push", "X-Hub-Signature-256": sign(body, "legacy-shared"), "X-GitHub-Delivery": "L1" },
		body,
	});
	assert.equal(res.status, 202);
	// só a rotina do user-2 (sem app) segue pelo hook antigo
	assert.deepEqual(calls.enqueued.map((e) => e.routineIds), [["r-user2"]]);
});
