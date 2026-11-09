/**
 * GitHub do v4 no worker (F9, leitura): o token é o do dono do run, a comparação sai formatada para o modelo, o 401 pede
 * reconexão e o erro de terceiros é redigido (sem segredo). Fakes no lugar do GitHub (sem rede).
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/github.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { GithubNotConnectedError } from "@workspace/agent";
import type { CompareData, GithubReadOps } from "@workspace/github";
import { createV4Github, type V4GithubDeps } from "./github.js";

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
