import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { GithubInstallationRecord } from "@workspace/db";
import type { AuthEnv } from "../middleware/auth.js";
import type { GithubAppRouteDeps } from "./github-app.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");

const { signGithubAppState } = await import("@workspace/agent-runtime");
const { createGithubAppRoutes } = await import("./github-app.js");

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const CREDS = { appId: "1", slug: "meu-app", privateKey: "pem", webhookSecret: "w", clientId: "Iv1.x", clientSecret: "cs", source: "db" as const };

function record(over: Partial<GithubInstallationRecord> = {}): GithubInstallationRecord {
	return {
		id: "row-1",
		userId: "user-1",
		installationId: "555",
		accountLogin: "acme",
		accountType: "Organization",
		repositorySelection: "selected",
		repositories: [{ fullName: "acme/site", private: true }],
		suspendedAt: null,
		createdAt: new Date(NOW),
		...over,
	};
}

type Calls = { saved: unknown[]; linked: unknown[]; deleted: Array<[string, string]>; converted: string[]; deletedConfig: number };

function build(opts: { creds?: typeof CREDS | null; hasConfigRecord?: boolean; installs?: GithubInstallationRecord[]; userInstallIds?: string[]; granted?: Record<string, string> } = {}) {
	const settings: { signature: boolean; signatureText: string | null } = { signature: false, signatureText: null };
	const calls: Calls = { saved: [], linked: [], deleted: [], converted: [], deletedConfig: 0 };
	const installs = opts.installs ?? [];
	const deps = {
		loadCredentials: async () => (opts.creds === undefined ? CREDS : opts.creds),
		getConfigRecord: async () => (opts.hasConfigRecord ? ({ appId: "1" } as never) : null),
		saveConverted: async (app: unknown) => void calls.saved.push(app),
		deleteConfig: async () => void calls.deletedConfig++,
		convertCode: async (code: string) => {
			calls.converted.push(code);
			return { data: { id: 9, slug: "novo", name: "Novo", client_id: "c", client_secret: "s", webhook_secret: "w", pem: "pem" } };
		},
		fetchInstallation: async () => ({ data: { id: "555", accountLogin: "acme", accountType: "Organization", repositorySelection: "selected", suspendedAt: null } }),
		installationToken: async () => ({ token: "ghs", expiresAt: NOW + 3_600_000 }),
		listRepos: async () => ({ data: [{ fullName: "acme/site", private: true }] }),
		exchangeOAuth: async () => ({ data: { accessToken: "ghu" } }),
		listUserInstallations: async () => ({ data: opts.userInstallIds ?? ["555"] }),
		link: async (input: { userId: string; installationId: string }) => {
			calls.linked.push(input);
			return record({ userId: input.userId, installationId: input.installationId });
		},
		listForUser: async (userId: string) => installs.filter((i) => i.userId === userId),
		deleteForUser: async (userId: string, id: string) => {
			calls.deleted.push([userId, id]);
			return installs.find((i) => i.userId === userId && i.id === id) ?? null;
		},
		updateInstallation: async () => true,
		fetchPermissions: async () => ({ data: opts.granted ?? { issues: "write", pull_requests: "write", contents: "write", metadata: "read" } }),
		getWriteSettings: async () => ({ ...settings }),
		saveWriteSettings: async (_userId: string, patch: Record<string, unknown>) => {
			Object.assign(settings, patch);
			return { ...settings };
		},
		isOwner: (email: string) => email === "dono@x.com",
		now: () => NOW,
		env: () => ({ ATLAS_URL: "https://app.exemplo.com" }) as NodeJS.ProcessEnv,
	} as unknown as GithubAppRouteDeps;
	const routes = createGithubAppRoutes(deps);
	const as = (userId: string, email = "dono@x.com") => {
		const outer = new Hono<AuthEnv>();
		outer.use("*", async (c, next) => {
			c.set("session", { user: { id: userId, email } } as AuthEnv["Variables"]["session"]);
			await next();
		});
		outer.route("/", routes);
		return outer;
	};
	return { as, calls, settings };
}

const state = (userId: string, purpose: "install" | "manifest", ttlMs?: number) => signGithubAppState({ userId, purpose, now: () => NOW, ttlMs });
const location = (res: Response) => res.headers.get("location") ?? "";

test("manifest/start: só o dono; devolve o formulário com o manifest e o state", async () => {
	const { as } = build({ creds: null });
	assert.equal((await as("user-1", "outro@x.com").request("/v1/github-app/manifest/start")).status, 404);
	const res = await as("user-1").request("/v1/github-app/manifest/start?name=Meu%20Agente");
	assert.equal(res.status, 200);
	const html = await res.text();
	assert.match(html, /action="https:\/\/github\.com\/settings\/apps\/new\?state=/);
	assert.match(html, /Meu Agente/);
	assert.match(html, /v1\/github-app\/webhook/);
	const org = await as("user-1").request("/v1/github-app/manifest/start?org=minha-org");
	assert.match(await org.text(), /organizations\/minha-org\/settings\/apps\/new/);
});

test("manifest/callback: troca o code, guarda o app e volta às configurações", async () => {
	const { as, calls } = build({ creds: null });
	const res = await as("user-1").request(`/v1/github-app/manifest/callback?code=abcdefgh1234&state=${encodeURIComponent(state("user-1", "manifest"))}`);
	assert.equal(res.status, 302);
	assert.match(location(res), /github=created/);
	assert.deepEqual(calls.converted, ["abcdefgh1234"]);
	assert.equal(calls.saved.length, 1);
});

test("manifest/callback: state de outro usuário, adulterado, expirado, de outro propósito ou não-dono não guarda nada", async () => {
	const { as, calls } = build({ creds: null });
	const hit = async (st: string, who = "user-1", email = "dono@x.com") =>
		as(who, email).request(`/v1/github-app/manifest/callback?code=abcdefgh1234&state=${encodeURIComponent(st)}`);
	assert.match(location(await hit(state("user-2", "manifest"))), /github_error=state_invalid/);
	assert.match(location(await hit(`${state("user-1", "manifest")}x`)), /github_error=state_invalid/);
	assert.match(location(await hit(state("user-1", "manifest", -1))), /github_error=state_invalid/);
	assert.match(location(await hit(state("user-1", "install"))), /github_error=state_invalid/);
	assert.equal((await hit(state("user-1", "manifest"), "user-1", "outro@x.com")).status, 404);
	assert.equal(calls.saved.length + calls.converted.length, 0);
});

test("install: redireciona ao GitHub com state assinado do usuário; sem app volta com erro", async () => {
	const { as } = build();
	const res = await as("user-1").request("/v1/github-app/install");
	assert.match(location(res), /^https:\/\/github\.com\/apps\/meu-app\/installations\/new\?state=/);
	const { as: none } = build({ creds: null });
	assert.match(location(await none("user-1").request("/v1/github-app/install")), /github_error=app_missing/);
});

const setupUrl = (st: string, extra = "installation_id=555&setup_action=install&code=oauthcode") =>
	`/v1/github-app/setup?${extra}&state=${encodeURIComponent(st)}`;

test("setup: vincula a instalação ao usuário do state quando o OAuth prova que ele a enxerga", async () => {
	const { as, calls } = build();
	const res = await as("user-1").request(setupUrl(state("user-1", "install")));
	assert.match(location(res), /github=installed/);
	assert.equal(calls.linked.length, 1);
	assert.deepEqual(calls.linked[0], {
		userId: "user-1",
		installationId: "555",
		accountLogin: "acme",
		accountType: "Organization",
		repositorySelection: "selected",
		repositories: [{ fullName: "acme/site", private: true }],
		suspendedAt: null,
	});
});

test("setup: state expirado, adulterado ou de outro usuário NÃO vincula", async () => {
	const { as, calls } = build();
	for (const st of [state("user-1", "install", -1), `${state("user-1", "install")}x`, state("user-2", "install")]) {
		assert.match(location(await as("user-1").request(setupUrl(st))), /github_error=state_invalid/);
	}
	assert.equal(calls.linked.length, 0);
});

test("setup: sem code OAuth ou instalação que o usuário do GitHub não enxerga NÃO vincula", async () => {
	const { as, calls } = build({ userInstallIds: ["999"] });
	assert.match(location(await as("user-1").request(setupUrl(state("user-1", "install"), "installation_id=555&setup_action=install"))), /authorization_missing/);
	assert.match(location(await as("user-1").request(setupUrl(state("user-1", "install")))), /installation_not_yours/);
	assert.match(location(await as("user-1").request(setupUrl(state("user-1", "install"), "installation_id=abc&code=x"))), /installation_invalid/);
	assert.equal(calls.linked.length, 0);
});

test("setup: aprovação pendente (setup_action=request) não vincula", async () => {
	const { as, calls } = build();
	const res = await as("user-1").request(setupUrl(state("user-1", "install"), "installation_id=555&setup_action=request"));
	assert.match(location(res), /github=pending/);
	assert.equal(calls.linked.length, 0);
});

test("status lista só as instalações do próprio usuário e nunca expõe segredos", async () => {
	const { as } = build({ installs: [record(), record({ id: "row-2", userId: "user-2", installationId: "777" })] });
	const body = (await (await as("user-1").request("/v1/github-app/status")).json()) as Record<string, unknown>;
	assert.equal(body.configured, true);
	assert.equal(body.isOwner, true);
	assert.equal((body.installations as unknown[]).length, 1);
	const text = JSON.stringify(body);
	for (const secret of ["pem", "cs", "webhookSecret", "clientSecret", "privateKey"]) assert.equal(text.includes(`"${secret}"`), false);
});

test("IDOR: usuário B não atualiza nem desvincula a instalação do usuário A (404)", async () => {
	const { as, calls } = build({ installs: [record()] });
	assert.equal((await as("user-2", "b@x.com").request("/v1/github-app/installations/row-1/refresh", { method: "POST" })).status, 404);
	assert.equal((await as("user-2", "b@x.com").request("/v1/github-app/installations/row-1", { method: "DELETE" })).status, 404);
	assert.equal((await as("user-1").request("/v1/github-app/installations/row-1", { method: "DELETE" })).status, 200);
	assert.deepEqual(calls.deleted.at(-1), ["user-1", "row-1"]);
});

test("DELETE /v1/github-app: só o dono remove o app guardado; env não pode", async () => {
	const { as, calls } = build();
	assert.equal((await as("user-1", "outro@x.com").request("/v1/github-app", { method: "DELETE" })).status, 404);
	assert.equal((await as("user-1").request("/v1/github-app", { method: "DELETE" })).status, 200);
	assert.equal(calls.deletedConfig, 1);
	const { as: env } = build({ creds: { ...CREDS, source: "env" as never } });
	assert.equal((await env("user-1").request("/v1/github-app", { method: "DELETE" })).status, 409);
});

test("status: avisa as permissões de escrita que o app ainda não tem (app criado antes da mudança)", async () => {
	const { as } = build({ installs: [record()], granted: { issues: "read", pull_requests: "write", contents: "write", metadata: "read" } });
	const body = (await (await as("user-1").request("/v1/github-app/status")).json()) as { missingWritePermissions: string[] };
	assert.deepEqual(body.missingWritePermissions, ["issues"]);
});

test("write-settings: só a assinatura é configurável; valor inválido é recusado", async () => {
	const { as, settings } = build({ installs: [record()] });
	const put = (body: unknown) =>
		as("user-1").request("/v1/github-app/write-settings", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
	assert.equal((await put({ signature: true, signatureText: "enviado pelo bot Cookie" })).status, 200);
	assert.deepEqual(settings, { signature: true, signatureText: "enviado pelo bot Cookie" });
	assert.equal((await put({ signature: "sim" })).status, 400);
	// A identidade das escritas não é configurável: writeAs é ignorado.
	await put({ writeAs: "user" });
	assert.equal("writeAs" in settings, false);
});
