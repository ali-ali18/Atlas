/**
 * Integração da F8 no adaptador `Sandbox` (VM falsa): `browser.*`, `card_fill` e `code.*` passam pelo MESMO adaptador, cada um
 * pela sua rota (VM da conversa x ambiente de código), e o usuário B nunca usa a VM nem a sessão de código do A.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/sandbox-integration.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BROWSER_KINDS, CODE_KINDS } from "@workspace/agent";
import type { DevClient, SandboxManager } from "@workspace/sandbox";
import { createCodeActionHandler, type CodeSession } from "./code-actions.js";
import { realCodeActionHandler } from "./code-actions-real.js";
import { createRunSandbox, createV4Sandbox, type V4SandboxDeps } from "./sandbox.js";

type Post = { userId: string; sessionId: string; body: { kind: string; params: unknown } };

function world() {
	const owners = new Map<string, string>();
	const resolved: string[] = [];
	const posts: Post[] = [];
	const deps: V4SandboxDeps = {
		createManager(userId) {
			return {
				async resolveSession(conversationId?: string) {
					resolved.push(`${userId}/${conversationId ?? "-"}`);
					const sessionId = `vm-${userId}-${conversationId ?? "none"}`;
					owners.set(sessionId, userId);
					return { sessionId, status: "running", viewerUrl: "", createdAt: "" };
				},
				async destroySession() {
					return true;
				},
				async execBrowserV4(sessionId: string, body: Post["body"]) {
					if (owners.get(sessionId) !== userId) throw new Error("Sandbox session not found");
					posts.push({ userId, sessionId, body });
					return { ok: true, data: { sections: [{ id: "s1", label: "Comentários", count: 1000 }] } };
				},
			} as unknown as SandboxManager;
		},
	};
	// Sessões de código: UM armazenamento para todos os donos (como o banco); o filtro por dono é do adaptador.
	const sessions = new Map<string, CodeSession>();
	const connected: string[] = [];
	const client = { list: async () => ({ path: "/workspace", entries: [], total: 0, truncated: false }) } as unknown as DevClient;
	const codeFor = () =>
		createCodeActionHandler({
			sessions: {
				get: async (id, userId) => (sessions.get(id)?.userId === userId ? sessions.get(id)! : null),
				create: async (userId, input) => {
					const session: CodeSession = { id: `cs${sessions.size + 1}`, userId, repo: input.repo ?? null, branch: null, status: "RUNNING" };
					sessions.set(session.id, session);
					return session;
				},
			},
			connect: async (session) => (connected.push(session.id), client),
		});
	return { deps, owners, resolved, posts, sessions, connected, codeFor };
}

const scope = (userId: string, conversationId: string | null = "conv-1") => ({ userId, runId: `run-${userId}`, conversationId });

test("browser e code passam pelo mesmo adaptador, cada um pela sua rota; code não sobe a VM do navegador", async () => {
	const w = world();
	const sandbox = createV4Sandbox({ scope: scope("A"), deps: w.deps, code: w.codeFor() });

	const code = await sandbox.run("A", { kind: CODE_KINDS.session, params: {} });
	assert.equal(code.ok, true);
	assert.deepEqual(w.resolved, [], "code.* não resolve a VM do navegador");
	assert.equal(w.posts.length, 0);

	const map = await sandbox.run("A", { kind: BROWSER_KINDS.map, params: {} });
	assert.equal(map.ok, true);
	assert.deepEqual(w.resolved, ["A/conv-1"]);
	assert.deepEqual(w.posts, [{ userId: "A", sessionId: "vm-A-conv-1", body: { kind: "browser.map", params: {} } }]);

	const list = await sandbox.run("A", { kind: CODE_KINDS.list, params: { sessionId: (code.data as { sessionId: string }).sessionId } });
	assert.equal(list.ok, true);
	assert.equal(w.posts.length, 1, "code.list não vira ação do navegador");
});

test("browser: formato inválido e URL privada nem chegam à VM", async () => {
	const w = world();
	const sandbox = createV4Sandbox({ scope: scope("A"), deps: w.deps });
	const bad = await sandbox.run("A", { kind: BROWSER_KINDS.open, params: { url: "http://169.254.169.254/latest/meta-data" } });
	assert.equal(bad.ok, false);
	assert.equal(w.posts.length, 0);
});

test("usuário B não usa a VM do A: o adaptador recusa o dono errado e cada dono só alcança a própria sessão", async () => {
	const w = world();
	const a = createV4Sandbox({ scope: scope("A"), deps: w.deps, code: w.codeFor() });
	const b = createV4Sandbox({ scope: scope("B"), deps: w.deps, code: w.codeFor() });
	await a.run("A", { kind: BROWSER_KINDS.map, params: {} });

	const cross = await a.run("B", { kind: BROWSER_KINDS.map, params: {} });
	assert.equal(cross.ok, false);
	const crossCode = await a.run("B", { kind: CODE_KINDS.session, params: {} });
	assert.equal(crossCode.ok, false);
	assert.equal(w.sessions.size, 0, "a recusa vem antes de criar sessão de código");

	await b.run("B", { kind: BROWSER_KINDS.map, params: {} });
	assert.deepEqual(w.posts.map((post) => [post.userId, post.sessionId]), [["A", "vm-A-conv-1"], ["B", "vm-B-conv-1"]]);
});

test("usuário B não lê nem roda na sessão de código do A (mesmo adaptador, mesmo armazenamento): 'not found'", async () => {
	const w = world();
	const a = createV4Sandbox({ scope: scope("A"), deps: null, code: w.codeFor() });
	const b = createV4Sandbox({ scope: scope("B"), deps: null, code: w.codeFor() });
	const sessionId = ((await a.run("A", { kind: CODE_KINDS.session, params: {} })).data as { sessionId: string }).sessionId;
	const before = w.connected.length;
	for (const [kind, params] of [
		[CODE_KINDS.list, { sessionId }],
		[CODE_KINDS.read, { sessionId, path: "a.js" }],
		[CODE_KINDS.shell, { sessionId, cmd: "ls" }],
		[CODE_KINDS.session, { sessionId }],
	] as const) {
		assert.deepEqual(await b.run("B", { kind, params }), { ok: false, error: "Coding session not found." }, kind);
	}
	assert.equal(w.connected.length, before, "nada chegou ao ambiente de código");
});

test("sem VM do navegador, browser.* falha honesto e card_fill também; code segue funcionando", async () => {
	const w = world();
	const sandbox = createV4Sandbox({ scope: scope("A"), deps: null, code: w.codeFor() });
	const map = await sandbox.run("A", { kind: BROWSER_KINDS.map, params: {} });
	assert.equal(map.ok, false);
	assert.match(map.error ?? "", /could not be started/);
	assert.equal((await sandbox.run("A", { kind: CODE_KINDS.session, params: {} })).ok, true);
});

test("disponibilidade do run: VM e código são independentes e vêm do ambiente", () => {
	const off = { SANDBOX_ENABLED: "0" } as NodeJS.ProcessEnv;
	assert.equal(createRunSandbox({ scope: scope("A"), env: off, wantCode: true }), undefined);
	const vmOnly = createRunSandbox({ scope: scope("A"), env: { SANDBOX_ENABLED: "1" } as NodeJS.ProcessEnv, wantCode: true });
	assert.deepEqual(vmOnly?.availability, { vm: true, code: false }, "DEV_SANDBOX_ENABLED desligado: código indisponível");
	const both = createRunSandbox({ scope: scope("A"), env: { SANDBOX_ENABLED: "1", DEV_SANDBOX_ENABLED: "1" } as NodeJS.ProcessEnv, wantCode: true });
	assert.deepEqual(both?.availability, { vm: true, code: true });
	const notWanted = createRunSandbox({ scope: scope("A"), env: { SANDBOX_ENABLED: "1", DEV_SANDBOX_ENABLED: "1" } as NodeJS.ProcessEnv });
	assert.deepEqual(notWanted?.availability, { vm: true, code: false }, "o bot não ligou o modo de código");
	assert.equal(realCodeActionHandler({ conversationId: null, provider: null }), null);
});
