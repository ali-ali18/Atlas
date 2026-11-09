/**
 * Ações `code.*` do v4 no worker (F8.2) com VM e banco falsos que filtram por dono como os reais. Sem rede, sem Docker.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/code-actions.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CODE_KINDS, type SandboxAction } from "@workspace/agent";
import type { DevClient, DevExecSnapshot } from "@workspace/sandbox";
import { DevSandboxError } from "@workspace/sandbox";
import { type CodeSession, createCodeActionHandler, parseStatus } from "./code-actions.js";

const TOKEN = "ghp_" + "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8";

function rig(over: { stdout?: string; exitCode?: number; patchError?: string } = {}) {
	const sessions = new Map<string, CodeSession>();
	const execs: string[] = [];
	const files = new Map<string, string>();
	let seq = 0;
	const snapshot = (stdout: string, exitCode: number): DevExecSnapshot => ({ id: `job${++seq}`, status: "done", running: false, exitCode, signal: null, timedOut: false, stdout, stderr: "", nextOut: stdout.length, nextErr: 0, truncated: false, omittedBytes: 0, durationMs: 12, cwd: "/workspace" });
	let last: DevExecSnapshot | undefined;
	const client = {
		execStart: async (input: { cmd: string }) => {
			execs.push(input.cmd);
			last = snapshot(over.stdout ?? "ok\n", over.exitCode ?? 0);
			return { id: last.id };
		},
		execPoll: async () => last!,
		execKill: async () => ({ ok: true }),
		list: async () => ({ path: "/workspace", entries: [{ path: "a.js", type: "file", size: 3 }], total: 1, truncated: false }),
		readFile: async (input: { path: string }) => ({ path: input.path, kind: "text", size: 3, content: "abc", totalLines: 1, startLine: 1, endLine: 1, nextOffset: null, truncated: false }),
		patchFile: async (input: { path: string }) => {
			if (over.patchError) throw new DevSandboxError(over.patchError, 409);
			return { path: input.path, diff: "-a\n+b", added: 1, removed: 1 };
		},
		writeFile: async (input: { path: string; content: string }) => (files.set(input.path, input.content), { path: input.path, created: true, bytes: input.content.length, diff: "+x", added: 1, removed: 0 }),
	} as unknown as DevClient;
	const handler = createCodeActionHandler({
		sessions: {
			get: async (id, userId) => (sessions.get(id)?.userId === userId ? sessions.get(id)! : null),
			create: async (userId, input) => {
				const s: CodeSession = { id: `s${sessions.size + 1}`, userId, repo: input.repo ?? null, branch: input.branch ?? null, status: "RUNNING" };
				sessions.set(s.id, s);
				return s;
			},
		},
		connect: async () => client,
		prepare: async (_s, _c, input) => ({ ...input, testCommand: "pnpm test", secrets: [TOKEN] }),
		secrets: () => [TOKEN],
		pollMs: 1,
	});
	const run = (userId: string, kind: string, params: unknown) => handler.run(userId, { kind, params } as SandboxAction);
	return { run, execs, files, handler };
}

async function open(r: ReturnType<typeof rig>, userId = "A"): Promise<string> {
	const res = await r.run(userId, CODE_KINDS.session, { repo: "acme/loja" });
	assert.equal(res.ok, true);
	return (res.data as { sessionId: string }).sessionId;
}

test("abre a sessão, devolve o comando de teste e reconhece só os kinds code.*", async () => {
	const r = rig();
	const res = await r.run("A", CODE_KINDS.session, { repo: "acme/loja", branch: "fix/preco" });
	assert.deepEqual(res.data, { sessionId: "s1", repo: "acme/loja", branch: "fix/preco", status: "RUNNING", testCommand: "pnpm test" });
	assert.equal(r.handler.handles("code.edit"), true);
	assert.equal(r.handler.handles("browser.open"), false);
	assert.deepEqual(await r.run("A", "browser.open", {}), { ok: false, error: "Unknown code action browser.open." });
});

test("IDOR: o usuário B recebe 'not found' em todo kind da sessão do usuário A, e nada chega à VM", async () => {
	const r = rig();
	const sessionId = await open(r, "A");
	const before = r.execs.length;
	const attempts: Array<[string, unknown]> = [
		[CODE_KINDS.session, { sessionId }],
		[CODE_KINDS.list, { sessionId }],
		[CODE_KINDS.read, { sessionId, path: "a.js" }],
		[CODE_KINDS.edit, { sessionId, path: "a.js", old: "a", new: "b" }],
		[CODE_KINDS.write, { sessionId, path: "x.js", content: "1" }],
		[CODE_KINDS.shell, { sessionId, cmd: "git status" }],
		[CODE_KINDS.test, { sessionId, cmd: "pnpm test" }],
		[CODE_KINDS.gitStatus, { sessionId }],
		[CODE_KINDS.diff, { sessionId }],
	];
	for (const [kind, params] of attempts) {
		const res = await r.run("B", kind, params);
		assert.deepEqual(res, { ok: false, error: "Coding session not found." }, kind);
	}
	assert.equal(r.execs.length, before);
	assert.equal(r.files.size, 0);
	assert.equal((await r.run("A", CODE_KINDS.list, { sessionId })).ok, true);
});

test("sessão inexistente responde igual à de outro dono", async () => {
	const r = rig();
	assert.deepEqual(await r.run("A", CODE_KINDS.read, { sessionId: "nao-existe", path: "a.js" }), { ok: false, error: "Coding session not found." });
});

test("shell: bloqueio fixo é recusado na fronteira, sem iniciar job; comando normal roda e volta com exitCode", async () => {
	const r = rig();
	const sessionId = await open(r);
	const denied = await r.run("A", CODE_KINDS.shell, { sessionId, cmd: "bash -c 'rm -rf /'" });
	assert.equal(denied.ok, false);
	assert.equal(r.execs.length, 0);
	const ok = await r.run("A", CODE_KINDS.test, { sessionId, cmd: "pnpm exec vitest run a.test.js" });
	assert.equal(ok.ok, true);
	assert.deepEqual({ exitCode: (ok.data as { exitCode: number }).exitCode, output: (ok.data as { output: string }).output }, { exitCode: 0, output: "ok\n" });
});

test("segredo conhecido da sessão e token padrão nunca saem na saída nem no erro", async () => {
	const r = rig({ stdout: `export GH_TOKEN=${TOKEN}\nBearer abcdefghijklmnop12345\n` });
	const sessionId = await open(r);
	const res = await r.run("A", CODE_KINDS.shell, { sessionId, cmd: "pnpm install" });
	const text = JSON.stringify(res);
	assert.equal(text.includes(TOKEN), false);
	assert.equal(text.includes("abcdefghijklmnop12345"), false);
	assert.equal(text.includes("[redacted]"), true);
	const failing = rig({ patchError: `old aparece 2 vezes; token ${TOKEN}` });
	const sid = await open(failing);
	const edit = await failing.run("A", CODE_KINDS.edit, { sessionId: sid, path: "a.js", old: "a", new: "b" });
	assert.equal(edit.ok, false);
	assert.equal(JSON.stringify(edit).includes(TOKEN), false);
	assert.match((edit as { error: string }).error, /old aparece 2 vezes/);
});

test("edição ambígua da VM chega ao modelo como erro útil (409), não como sucesso", async () => {
	const r = rig({ patchError: "old aparece 2 vezes (linhas 1, 3); inclua mais contexto" });
	const sessionId = await open(r);
	const res = await r.run("A", CODE_KINDS.edit, { sessionId, path: "a.js", old: "a", new: "b" });
	assert.deepEqual(res, { ok: false, error: "old aparece 2 vezes (linhas 1, 3); inclua mais contexto" });
});

test("caminho fora do workspace e parâmetros inválidos são recusados antes da VM", async () => {
	const r = rig();
	const sessionId = await open(r);
	assert.equal((await r.run("A", CODE_KINDS.read, { sessionId, path: "../../etc/passwd" })).ok, false);
	assert.equal((await r.run("A", CODE_KINDS.write, { sessionId, path: "/etc/cron.d/x", content: "x" })).ok, false);
	assert.equal((await r.run("A", CODE_KINDS.shell, { sessionId, cmd: "ls", cwd: "/root" })).ok, false);
	assert.equal((await r.run("A", CODE_KINDS.edit, { sessionId, path: "a.js", old: "", new: "b" })).ok, false);
	assert.equal(r.files.size, 0);
});

test("saída longa vai para um arquivo do workspace e o resultado aponta o caminho (nada some em silêncio)", async () => {
	const r = rig({ stdout: "x".repeat(40_000) });
	const sessionId = await open(r);
	const res = await r.run("A", CODE_KINDS.shell, { sessionId, cmd: "pnpm test" });
	const data = res.data as { output: string; spillPath: string };
	assert.match(data.spillPath, /^\/workspace\/\.atlas-output\/job\d+\.log$/);
	assert.equal(r.files.get(data.spillPath)?.length, 40_000);
	assert.match(data.output, /more characters in/);
});

test("git status: converte a saída porcelain", () => {
	assert.deepEqual(parseStatus("## main...origin/main\n M src/a.js\n?? novo.txt\n"), { branch: "main", files: [{ status: "M", path: "src/a.js" }, { status: "??", path: "novo.txt" }], clean: false });
	assert.deepEqual(parseStatus("## main\n"), { branch: "main", files: [], clean: true });
	assert.equal(parseStatus("## HEAD (no branch)\n").branch, null);
});
