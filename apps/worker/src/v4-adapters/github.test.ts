/**
 * GitHub do v4 no worker (F9, leitura): o token é o do dono do run, a comparação sai formatada para o modelo, o 401 pede
 * reconexão e o erro de terceiros é redigido (sem segredo). Fakes no lugar do GitHub (sem rede).
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/github.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { GithubNotConnectedError } from "@workspace/agent";
import type { CompareData, GithubReadOps } from "@workspace/github";
import { gateGithubWrite, type GithubWriteGateDeps } from "@workspace/github";
import { createV4Github, createV4GithubWriter, githubWriteRequest, type V4GithubDeps } from "./github.js";

const COMPARE: CompareData = {
	repo: "acme/site",
	base: "main",
	head: "feature/x",
	status: "ahead",
	aheadBy: 1,
	behindBy: 0,
	totalCommits: 1,
	commits: [{ sha: "a".repeat(40), subject: "Corrige o login", author: "ana" }],
	commitsTruncated: false,
	files: [{ path: "src/login.ts", status: "modified", additions: 3, deletions: 1 }],
	filesTotal: 1,
	filesTruncated: false,
	additions: 3,
	deletions: 1,
};

type Rig = { deps: V4GithubDeps; resolved: Array<{ userId: string; repo?: string }>; marked: string[]; compared: Array<{ repo: string; base: string; head: string; options: unknown }> };

function rig(options: { source?: GithubReadOps["source"]; error?: string; listError?: { status: number; message: string }; compareError?: { status: number; message: string } } = {}): Rig {
	const resolved: Rig["resolved"] = [];
	const marked: string[] = [];
	const compared: Rig["compared"] = [];
	const ops: GithubReadOps = {
		source: options.source ?? "native",
		getLogin: async () => ({ data: {} }),
		listRepos: async () => (options.listError ? { error: options.listError } : { data: [{ fullName: "acme/site", private: true, defaultBranch: "main", pushedAt: "2026-11-01T00:00:00Z" }] }),
		listPulls: async () => ({ data: [] }),
		listBranches: async () => ({ data: [] }),
		compare: async (repo, base, head, o) => (compared.push({ repo, base, head, options: o }), options.compareError ? { error: options.compareError } : { data: COMPARE }),
	};
	const deps: V4GithubDeps = {
		// Só o dono "user-a" tem GitHub conectado; o resolvedor recebe o id do RUN.
		resolveReadOps: async (userId, o) => (resolved.push({ userId, ...(o?.repo && { repo: o.repo }) }), userId === "user-a" && !options.error ? { ops } : { error: options.error ?? "Conecte o GitHub no Marketplace ou pelo Composio" }),
		markAuthFailed: async (userId) => void marked.push(userId),
		gateWrite: async () => ({ ok: false, text: "sem escrita neste teste", truncated: false }),
		confirmWrites: async () => false,
	};
	return { deps, resolved, marked, compared };
}

test("lista os repositórios do dono do run", async () => {
	const r = rig();
	const repos = await createV4Github(r.deps).listRepos("user-a");
	assert.deepEqual(repos, [{ fullName: "acme/site", private: true, defaultBranch: "main", pushedAt: "2026-11-01T00:00:00Z" }]);
	assert.deepEqual(r.resolved, [{ userId: "user-a" }]);
});

test("outro dono (B) sem GitHub conectado não lê nada: falha com a instrução de conectar, nunca lista vazia", async () => {
	const r = rig();
	await assert.rejects(createV4Github(r.deps).listRepos("user-b"), (error: unknown) => {
		assert.ok(error instanceof GithubNotConnectedError);
		assert.equal(error.code, "not_connected");
		assert.match(error.message, /Conecte o GitHub no Marketplace/);
		return true;
	});
	await assert.rejects(createV4Github(r.deps).compare("user-b", { repo: "acme/site", base: "main", head: "x", includePatch: false }), GithubNotConnectedError);
	assert.deepEqual(r.compared, []);
});

test("compara com o token escopado ao repo, pedindo o detalhe dos commits, e devolve o texto formatado", async () => {
	const r = rig();
	const text = await createV4Github(r.deps).compare("user-a", { repo: "acme/site", base: "main", head: "feature/x", includePatch: true });
	assert.match(text, /Corrige o login/);
	assert.match(text, /src\/login\.ts/);
	assert.deepEqual(r.resolved, [{ userId: "user-a", repo: "acme/site" }]);
	assert.deepEqual(r.compared, [{ repo: "acme/site", base: "main", head: "feature/x", options: { commitDetails: true, includePatch: true } }]);
});

test("401 do token nativo: marca a conexão para reconectar e diz como; no app do GitHub não marca a conexão do Marketplace", async () => {
	const native = rig({ listError: { status: 401, message: "Bad credentials" } });
	await assert.rejects(createV4Github(native.deps).listRepos("user-a"), (error: unknown) => {
		assert.ok(error instanceof GithubNotConnectedError);
		assert.equal(error.code, "needs_connection");
		assert.match(error.message, /Reconecte o GitHub no Marketplace/);
		return true;
	});
	assert.deepEqual(native.marked, ["user-a"]);
	const app = rig({ source: "app", compareError: { status: 401, message: "x" } });
	await assert.rejects(createV4Github(app.deps).compare("user-a", { repo: "acme/site", base: "a", head: "b", includePatch: false }), /Reinstale o app do GitHub/);
	assert.deepEqual(app.marked, []);
});

test("erro do GitHub vira falha com a mensagem real e a dica, sem vazar token", async () => {
	const r = rig({ compareError: { status: 404, message: "Not Found ghp_abcdefghijklmnopqrstuvwxyz0123456789" } });
	await assert.rejects(createV4Github(r.deps).compare("user-a", { repo: "acme/site", base: "a", head: "b", includePatch: false }), (error: unknown) => {
		assert.ok(error instanceof Error && !(error instanceof GithubNotConnectedError));
		assert.match(error.message, /Não consegui comparar no GitHub \(Not Found/);
		assert.doesNotMatch(error.message, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
		assert.match(error.message, /Hint:/);
		return true;
	});
	assert.equal(r.marked.length, 0);
});

test("run cancelado não chama o GitHub", async () => {
	const r = rig();
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(createV4Github(r.deps).compare("user-a", { repo: "acme/site", base: "a", head: "b", includePatch: false }, controller.signal), /Cancelled/);
	assert.deepEqual(r.compared, []);
});

// ---- Escrita pelo app do dono (portão de identidade do legado, sem rede: db, credenciais e fetch falsos) ----

type Inst = Awaited<ReturnType<NonNullable<GithubWriteGateDeps["listInstallations"]>>>[number];
const CREDS = { appId: "1", slug: "atlas-app", name: "Atlas App", privateKey: "pem", webhookSecret: "w", source: "db" as const };
const installFor = (userId: string, repo: string): Inst => ({ id: `row-${userId}`, userId, installationId: `inst-${userId}`, accountLogin: repo.split("/")[0]!, accountType: "User", repositorySelection: "selected", repositories: [{ fullName: repo, private: true }], suspendedAt: null, createdAt: new Date(0) }) as unknown as Inst;

function writeRig(options: { status?: number; creds?: typeof CREDS | null } = {}) {
	const calls: Array<{ url: string; method: string; token: string | null; body: Record<string, unknown> | null }> = [];
	// Só o dono "user-a" tem o app instalado em acme/site; a lista é filtrada pelo userId que o portão recebe.
	const installs = [installFor("user-a", "acme/site")];
	const fetchFn = (async (url: string, init: RequestInit) => {
		calls.push({ url, method: init.method ?? "GET", token: new Headers(init.headers).get("authorization"), body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
		const status = options.status ?? 201;
		const body = status < 300 ? { number: 12, html_url: "https://github.com/acme/site/issues/12", merged: true } : { message: "Validation Failed ghp_abcdefghijklmnopqrstuvwxyz0123456789" };
		return new Response(JSON.stringify(body), { status });
	}) as unknown as typeof fetch;
	const gateDeps: GithubWriteGateDeps = {
		loadSettings: async () => ({ signature: false, signatureText: null }),
		listInstallations: async (userId) => installs.filter((i) => i.userId === userId),
		loadCredentials: async () => (options.creds === undefined ? CREDS : options.creds),
		installationToken: async () => ({ token: "ghs_app", expiresAt: Date.now() + 3_600_000 }),
		refreshInstallation: async () => null,
		fetchFn,
	};
	const seen: string[] = [];
	const writer = createV4GithubWriter({ botName: "Bot", deps: { gateWrite: async (input) => (seen.push(input.userId), gateGithubWrite(input, gateDeps)) } });
	return { calls, seen, writer };
}

test("escrita: abre a issue com o token de instalação do app e devolve número e link", async () => {
	const r = writeRig();
	const receipt = await r.writer.write("user-a", { kind: "issue_create", repo: "acme/site", title: "Bug", body: "texto", labels: ["bug"] });
	assert.deepEqual({ number: receipt.number, url: receipt.url }, { number: 12, url: "https://github.com/acme/site/issues/12" });
	assert.equal(r.calls.length, 1);
	assert.equal(r.calls[0]!.method, "POST");
	assert.match(r.calls[0]!.url, /\/repos\/acme\/site\/issues$/);
	assert.match(r.calls[0]!.token ?? "", /ghs_app/);
	assert.deepEqual(r.calls[0]!.body, { title: "Bug", body: "texto", labels: ["bug"] });
	assert.deepEqual(r.seen, ["user-a"]);
});

test("escrita: B no repositório do A não escreve nada (app não instalado para B), com erro honesto e sem prometer cartão", async () => {
	const r = writeRig();
	await assert.rejects(r.writer.write("user-b", { kind: "comment", repo: "acme/site", number: 3, body: "oi" }), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.match(error.message, /Nothing was sent: the GitHub app is not installed on acme\/site/);
		assert.match(error.message, /Settings → Connections → GitHub/);
		assert.doesNotMatch(error.message, /cartão/i);
		return true;
	});
	assert.deepEqual(r.calls, []);
});

test("escrita: app não criado no servidor e falha do GitHub viram erro; o token nunca vaza", async () => {
	const missing = writeRig({ creds: null });
	await assert.rejects(missing.writer.write("user-a", { kind: "issue_create", repo: "acme/site", title: "x" }), /not set up on this server/);
	const failing = writeRig({ status: 422 });
	await assert.rejects(failing.writer.write("user-a", { kind: "issue_create", repo: "acme/site", title: "x" }), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.match(error.message, /Could not write to GitHub \(GitHub 422/);
		assert.doesNotMatch(error.message, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
		assert.match(error.message, /Hint:/);
		return true;
	});
});

test("escrita: merge devolve o link do PR e a ação vira o nome/args do portão do legado", async () => {
	const r = writeRig();
	const receipt = await r.writer.write("user-a", { kind: "pr_merge", repo: "acme/site", number: 9, mergeMethod: "squash" });
	assert.equal(receipt.url, "https://github.com/acme/site/issues/12");
	assert.match(r.calls[0]!.url, /\/pulls\/9\/merge$/);
	assert.equal(r.calls[0]!.method, "PUT");
	assert.deepEqual(githubWriteRequest({ kind: "pr_create", repo: "acme/site", title: "t", head: "fix/x", base: "main", draft: true }), { toolName: "create_pull_request", args: { owner: "acme", repo: "site", title: "t", head: "fix/x", base: "main", draft: true } });
	assert.deepEqual(githubWriteRequest({ kind: "issue_update", repo: "acme/site", number: 4, state: "closed", stateReason: "completed" }), { toolName: "issue_write", args: { owner: "acme", repo: "site", method: "update", issue_number: 4, state: "closed", state_reason: "completed" } });
});

test("escrita: run cancelado não chama o GitHub", async () => {
	const r = writeRig();
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(r.writer.write("user-a", { kind: "comment", repo: "acme/site", number: 1, body: "x" }, controller.signal), /Cancelled/);
	assert.deepEqual(r.calls, []);
});
