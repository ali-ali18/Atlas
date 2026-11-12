/**
 * Entrega do código no worker (F9): commit, push, preparo do PR e CI sobre a VM falsa (script por comando). Sem rede, sem Docker.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/code-actions-delivery.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CODE_KINDS, type SandboxAction } from "@workspace/agent";
import type { DevClient, DevExecSnapshot } from "@workspace/sandbox";
import { type CodeActionDeps, type CodeSession, createCodeActionHandler, isProtectedBranch, pushRefusal } from "./code-actions.js";
import { realCodeActionDeps } from "./code-actions-real.js";

const TOKEN = "ghp_" + "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8";

type Job = { cmd: string; env: Record<string, string> };
type Reply = { stdout?: string; exitCode?: number };

function rig(over: { respond?: (job: Job) => Reply | undefined; github?: CodeActionDeps["github"]; repo?: string | null } = {}) {
	const sessions = new Map<string, CodeSession>();
	const jobs: Job[] = [];
	let seq = 0;
	let last: DevExecSnapshot | undefined;
	const snap = (stdout: string, exitCode: number): DevExecSnapshot => ({ id: `job${++seq}`, status: "done", running: false, exitCode, signal: null, timedOut: false, stdout, stderr: "", nextOut: stdout.length, nextErr: 0, truncated: false, omittedBytes: 0, durationMs: 5, cwd: "/workspace/loja" });
	const client = {
		execStart: async (input: { cmd: string; env?: Record<string, string> }) => {
			const job = { cmd: input.cmd, env: input.env ?? {} };
			jobs.push(job);
			const reply = over.respond?.(job) ?? defaults(job);
			last = snap(reply.stdout ?? "", reply.exitCode ?? 0);
			return { id: last.id };
		},
		execPoll: async () => last!,
		execKill: async () => ({ ok: true }),
		writeFile: async () => ({ path: "x", created: true, bytes: 1, diff: "", added: 0, removed: 0 }),
		readFile: async (input: { path: string }) => ({ path: input.path, kind: "text", size: 3, content: "abc", totalLines: 1, startLine: 1, endLine: 1, nextOffset: null, truncated: false }),
	} as unknown as DevClient;
	const handler = createCodeActionHandler({
		sessions: {
			get: async (id, userId) => (sessions.get(id)?.userId === userId ? sessions.get(id)! : null),
			create: async (userId, input) => {
				const s: CodeSession = { id: `s${sessions.size + 1}`, userId, repo: over.repo === undefined ? (input.repo ?? "acme/loja") : over.repo, branch: input.branch ?? null, status: "RUNNING" };
				sessions.set(s.id, s);
				return s;
			},
		},
		connect: async () => client,
		prepare: async (_s, _c, input) => ({ ...input, secrets: [TOKEN] }),
		secrets: () => [TOKEN],
		gitEnv: async () => ({ GH_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN }),
		...(over.github && { github: over.github }),
		pollMs: 1,
	});
	const run = (userId: string, kind: string, params: unknown) => handler.run(userId, { kind, params } as SandboxAction);
	return { run, jobs };
}

const inspect = (head: string, def = "main", dirty = 0) => `head=${head}\ndefault=${def}\ndirty=${dirty}\nsha=abc123\n`;
function defaults(job: Job): Reply {
	if (job.cmd.includes('echo "default='))
		return { stdout: inspect("fix/preco") };
	return { stdout: "" };
}

async function open(r: ReturnType<typeof rig>, userId = "A"): Promise<string> {
	const res = await r.run(userId, CODE_KINDS.session, { repo: "acme/loja" });
	assert.equal(res.ok, true);
	return (res.data as { sessionId: string }).sessionId;
}

const isPush = (job: Job) => /\bpush\b/.test(job.cmd);

test("pushRefusal e isProtectedBranch: padrão, main e master nunca; HEAD solto e nome estranho também", () => {
	assert.match(pushRefusal("main", "main") ?? "", /default branch/);
	assert.match(pushRefusal("master", "") ?? "", /default branch/);
	assert.match(pushRefusal("trunk", "trunk") ?? "", /default branch/);
	assert.match(pushRefusal("", "main") ?? "", /detached/);
	assert.match(pushRefusal("a b", "main") ?? "", /unsupported/);
	assert.equal(pushRefusal("fix/preco", "main"), null);
	assert.equal(isProtectedBranch("develop", "develop"), true);
});

test("push: recusa a branch padrão sem iniciar o push, mesmo com a padrão chamada de outra coisa", async () => {
	for (const [head, def] of [["main", "main"], ["master", "master"], ["trunk", "trunk"], ["main", ""]] as const) {
		const r = rig({ respond: (job) => (job.cmd.includes('echo "default=') ? { stdout: inspect(head, def) } : undefined) });
		const sessionId = await open(r);
		const res = await r.run("A", CODE_KINDS.push, { sessionId });
		assert.equal(res.ok, false, head);
		assert.match(res.error ?? "", /default branch/);
		assert.equal(r.jobs.some(isPush), false, `${head}: nenhum push`);
	}
});

test("push: branch nova sobe sem força (refspec sem '+'), com a credencial SÓ no job do push e nunca no resultado", async () => {
	const r = rig({ respond: (job) => (isPush(job) ? { stdout: " * [new branch]      refs/heads/fix/preco -> fix/preco\n" } : undefined) });
	const sessionId = await open(r);
	const res = await r.run("A", CODE_KINDS.push, { sessionId });
	assert.equal(res.ok, true);
	assert.deepEqual(res.data, { branch: "fix/preco", repo: "acme/loja", sha: "abc123", newBranch: true, url: "https://github.com/acme/loja/tree/fix/preco" });
	const push = r.jobs.find(isPush)!;
	assert.equal(push.env.GH_TOKEN, TOKEN);
	assert.equal(push.env.DEV_HEAD, "fix/preco");
	assert.ok(!/--force|-f\b|\+refs|\+\$/.test(push.cmd), push.cmd);
	assert.ok(push.cmd.includes('"refs/heads/$DEV_HEAD:refs/heads/$DEV_HEAD"'));
	for (const job of r.jobs.filter((j) => !isPush(j))) assert.equal(job.env.GH_TOKEN, undefined, `sem token fora do push: ${job.cmd.slice(0, 40)}`);
	assert.ok(!JSON.stringify(res).includes(TOKEN));
});

test("push rejeitado: erro com o motivo real, a dica de não forçar e sem o token (nem se o git o imprimir)", async () => {
	const r = rig({ respond: (job) => (isPush(job) ? { exitCode: 1, stdout: ` ! [rejected] fix/preco -> fix/preco (fetch first)\nerror: failed to push to https://x:${TOKEN}@github.com/acme/loja.git\n` } : undefined) });
	const sessionId = await open(r);
	const res = await r.run("A", CODE_KINDS.push, { sessionId });
	assert.equal(res.ok, false);
	assert.match(res.error ?? "", /do not force/);
	assert.ok(!(res.error ?? "").includes(TOKEN));
});

test("push de sessão sem repositório é recusado com a dica", async () => {
	const r = rig({ repo: null });
	const sessionId = await open(r);
	const res = await r.run("A", CODE_KINDS.push, { sessionId });
	assert.equal(res.ok, false);
	assert.match(res.error ?? "", /no GitHub repository/);
	assert.equal(r.jobs.some(isPush), false);
});

test("commit: na branch padrão exige branch nova; com branch cria, comita e devolve sha, branch e arquivos; a mensagem vai redigida pelo env", async () => {
	const staged = "src/price.js\nREADME.md\n";
	const r = rig({
		respond: (job) => {
			if (job.cmd.includes('echo "default=')) return { stdout: inspect("main", "main") };
			if (job.cmd.includes("diff --cached --name-only")) return { stdout: staged };
			if (job.cmd.includes("git commit")) return { stdout: "sha=deadbeef\nbranch=fix/preco\nsubject=fix: preço\n" };
			return undefined;
		},
	});
	const sessionId = await open(r);
	const refused = await r.run("A", CODE_KINDS.commit, { sessionId, message: "fix: preço" });
	assert.equal(refused.ok, false);
	assert.match(refused.error ?? "", /default branch/);
	assert.equal(r.jobs.some((j) => j.cmd.includes("git commit")), false);
	const ok = await r.run("A", CODE_KINDS.commit, { sessionId, message: `fix: preço ${TOKEN}`, branch: "fix/preco" });
	assert.equal(ok.ok, true);
	assert.deepEqual(ok.data, { sha: "deadbeef", branch: "fix/preco", subject: "fix: preço", files: 2, createdBranch: true });
	const commit = r.jobs.find((j) => j.cmd.includes("git commit"))!;
	assert.ok(!commit.env.DEV_MSG!.includes(TOKEN));
	assert.ok(!commit.cmd.includes("fix: preço"), "a mensagem entra por env, nunca no texto do comando");
	assert.equal(commit.env.GH_TOKEN, undefined);
});

test("commit com arquivo de segredo no stage: desfaz o stage, não comita e diz quais", async () => {
	const r = rig({
		respond: (job) => {
			if (job.cmd.includes("diff --cached --name-only")) return { stdout: "src/a.js\napps/api/.env.local\n" };
			return undefined;
		},
	});
	const sessionId = await open(r);
	const res = await r.run("A", CODE_KINDS.commit, { sessionId, message: "x", branch: "fix/a" });
	assert.equal(res.ok, false);
	assert.match(res.error ?? "", /secret files .*\.env\.local/);
	assert.equal(r.jobs.some((j) => j.cmd.includes("git commit")), false);
	assert.equal(r.jobs.some((j) => j.cmd.includes("git reset -q")), true);
});

test("commit sem mudanças e branch inválida são recusados", async () => {
	const r = rig({ respond: (job) => (job.cmd.includes("diff --cached --name-only") ? { stdout: "" } : undefined) });
	const sessionId = await open(r);
	const none = await r.run("A", CODE_KINDS.commit, { sessionId, message: "x", branch: "fix/a" });
	assert.match(none.error ?? "", /Nothing to commit/);
	const bad = await r.run("A", CODE_KINDS.commit, { sessionId, message: "x", branch: "a b..c" });
	assert.match(bad.error ?? "", /unsupported branch name/);
});

/** Os três jobs do pr_prepare (plano, rede, contagem) respondem com o mesmo bloco; cada um lê só as chaves que emite. */
const isPrJob = (job: Job) => /echo "(base|remote|ahead)=/.test(job.cmd);
const PR_REPLY = (remote: string) => `head=fix/preco\nbase=main\ndirty=0\nahead=2\nfiles=3\nsha=abc123\nremote=${remote}\n`;

test("pr_prepare: devolve os fatos da SESSÃO; 'pushed' só se o origin tem o mesmo commit; PR aberto da branch vem junto", async () => {
	const github: CodeActionDeps["github"] = { findOpenPull: async () => ({ number: 9, url: "https://github.com/acme/loja/pull/9", state: "open", title: "Já existe", base: "main", head: "fix/preco" }), pull: async () => null, jobLog: async () => "" };
	const behind = rig({ github, respond: (job) => (isPrJob(job) ? { stdout: PR_REPLY("") } : undefined) });
	const a = await open(behind);
	const notPushed = await behind.run("A", CODE_KINDS.prPrepare, { sessionId: a });
	assert.deepEqual(notPushed.data, { repo: "acme/loja", head: "fix/preco", base: "main", ahead: 2, files: 3, dirty: 0, pushed: false, existingPr: { number: 9, url: "https://github.com/acme/loja/pull/9", state: "open", title: "Já existe" } });
	const pushed = rig({ respond: (job) => (isPrJob(job) ? { stdout: PR_REPLY("abc123") } : undefined) });
	const b = await open(pushed);
	const prepared = await pushed.run("A", CODE_KINDS.prPrepare, { sessionId: b });
	assert.equal((prepared.data as { pushed: boolean }).pushed, true);
	const withToken = pushed.jobs.find((j) => j.cmd.includes("ls-remote"))!;
	assert.equal(withToken.env.GH_TOKEN, TOKEN, "o fetch e o ls-remote precisam da credencial do dono");
});

const CI = {
	pr: { number: 7, url: "https://github.com/acme/loja/pull/7", state: "open" as const, title: "Ajusta", base: "main", head: "fix/preco" },
	checks: [{ name: "test", status: "completed" as const, conclusion: "failure", jobId: 42, durationMs: 1000 }],
	summary: "failing" as const,
};

test("ci: pela branch da sessão ou pelo número; sem PR volta 'none' com a dica; falha do GitHub vira erro sem token", async () => {
	const calls: unknown[] = [];
	const github: CodeActionDeps["github"] = {
		findOpenPull: async () => null,
		pull: async (_s, repo, ref) => (calls.push([repo, ref]), "head" in ref && ref.head === "sem-pr" ? null : CI),
		jobLog: async () => "",
	};
	const r = rig({ github });
	const sessionId = await open(r);
	const res = await r.run("A", CODE_KINDS.ci, { sessionId });
	assert.equal(res.ok, true);
	assert.deepEqual((res.data as { checks: unknown[]; summary: string }).summary, "failing");
	assert.deepEqual(calls[0], ["acme/loja", { head: "fix/preco" }]);
	await r.run("A", CODE_KINDS.ci, { sessionId, number: 12 });
	assert.deepEqual(calls[1], ["acme/loja", { number: 12 }]);
	const none = rig({ github, respond: (job) => (job.cmd.includes('echo "default=') ? { stdout: inspect("sem-pr") } : undefined) });
	const n = await open(none);
	const noPr = await none.run("A", CODE_KINDS.ci, { sessionId: n });
	assert.equal((noPr.data as { pr: unknown }).pr, null);
	const failing = rig({ github: { ...github, pull: async () => { throw new Error(`GitHub recusou ${TOKEN}`); } } });
	const f = await open(failing);
	const err = await failing.run("A", CODE_KINDS.ci, { sessionId: f });
	assert.equal(err.ok, false);
	assert.ok(!(err.error ?? "").includes(TOKEN));
});

test("ci_log: fim do log primeiro, partes por offset, linhas ##[error] anotadas, ANSI e hora limpos, segredo redigido", async () => {
	const body = Array.from({ length: 600 }, (_, i) => `2026-11-09T10:00:00.000Z \u001b[32mlinha ${i}\u001b[0m`).join("\n");
	const raw = `${body}\n2026-11-09T10:00:01Z ##[error]Process completed with exit code 1.\n2026-11-09T10:00:02Z token ${TOKEN}`;
	const github: CodeActionDeps["github"] = { findOpenPull: async () => null, pull: async () => null, jobLog: async () => raw };
	const r = rig({ github });
	const sessionId = await open(r);
	const tail = await r.run("A", CODE_KINDS.ciLog, { sessionId, jobId: 42, limit: 1_000 });
	assert.equal(tail.ok, true);
	const t = tail.data as { text: string; startOffset: number; endOffset: number; totalChars: number; previousOffset: number | null; nextOffset: number | null; errors?: string[] };
	assert.equal(t.nextOffset, null);
	assert.ok(t.previousOffset !== null && t.previousOffset < t.startOffset);
	assert.ok(t.text.includes("exit code 1"));
	assert.ok(!t.text.includes("\u001b") && !t.text.includes("2026-11-09T"));
	assert.ok(!JSON.stringify(tail).includes(TOKEN));
	assert.deepEqual(t.errors, ["Process completed with exit code 1."]);
	const first = await r.run("A", CODE_KINDS.ciLog, { sessionId, jobId: 42, limit: 1_000, offset: 0 });
	const f = first.data as { startOffset: number; previousOffset: number | null; nextOffset: number | null; endOffset: number };
	assert.equal(f.startOffset, 0);
	assert.equal(f.previousOffset, null);
	assert.equal(f.nextOffset, f.endOffset);
});

test("B×A: o usuário B recebe 'not found' em commit, push, pr_prepare, ci e ci_log da sessão de A, e nada chega à VM nem ao GitHub", async () => {
	let githubCalls = 0;
	const github: CodeActionDeps["github"] = { findOpenPull: async () => (githubCalls++, null), pull: async () => (githubCalls++, CI), jobLog: async () => (githubCalls++, "") };
	const r = rig({ github });
	const sessionId = await open(r, "A");
	const before = r.jobs.length;
	const attempts: Array<[string, unknown]> = [
		[CODE_KINDS.commit, { sessionId, message: "x", branch: "y" }],
		[CODE_KINDS.push, { sessionId }],
		[CODE_KINDS.prPrepare, { sessionId }],
		[CODE_KINDS.ci, { sessionId }],
		[CODE_KINDS.ciLog, { sessionId, jobId: 1 }],
	];
	for (const [kind, params] of attempts) assert.deepEqual(await r.run("B", kind, params), { ok: false, error: "Coding session not found." }, kind);
	assert.equal(r.jobs.length, before);
	assert.equal(githubCalls, 0);
});

test("parâmetros inválidos falham com a lista do aceito (nada de campo desconhecido em silêncio)", async () => {
	const r = rig();
	const sessionId = await open(r);
	const bad = await r.run("A", CODE_KINDS.ciLog, { sessionId, jobId: 0 });
	assert.equal(bad.ok, false);
	assert.match(bad.error ?? "", /Invalid parameters/);
});

test("montagem real: a credencial do dono sai só por gitEnv, e a leitura do CI usa o token sem devolvê-lo", async () => {
	const seen: Array<{ url: string; auth: string | null }> = [];
	const fetchFn = (async (url: string, init?: { headers?: Record<string, string> }) => {
		seen.push({ url: String(url), auth: init?.headers?.Authorization ?? null });
		if (String(url).includes("/pulls?")) return new Response(JSON.stringify([{ number: 7, html_url: "https://github.com/acme/loja/pull/7", state: "open", title: "Ajusta", base: { ref: "main" }, head: { ref: "fix/preco", sha: "abc" } }]), { status: 200 });
		if (String(url).includes("/pulls/7")) return new Response(JSON.stringify({ number: 7, html_url: "https://github.com/acme/loja/pull/7", state: "open", title: "Ajusta", base: { ref: "main" }, head: { ref: "fix/preco", sha: "abc" } }), { status: 200 });
		if (String(url).includes("/check-runs")) return new Response(JSON.stringify({ check_runs: [{ name: "test", status: "completed", conclusion: "failure", html_url: "https://github.com/acme/loja/actions/runs/1/job/42" }] }), { status: 200 });
		return new Response(JSON.stringify({ statuses: [] }), { status: 200 });
	}) as unknown as typeof fetch;
	const deps = realCodeActionDeps({ provider: {} as never, getGithubToken: async (userId, repo) => (userId === "A" && repo === "acme/loja" ? { token: TOKEN } : { error: "sem conexão" }), githubFetch: fetchFn });
	const session: CodeSession = { id: "s1", userId: "A", repo: "acme/loja", branch: null, status: "RUNNING" };
	assert.deepEqual(await deps.gitEnv!(session), { GH_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN });
	assert.deepEqual(await deps.gitEnv!({ ...session, userId: "B" }), {}, "o dono B não recebe o token do A");
	const found = await deps.github!.pull(session, "acme/loja", { head: "fix/preco" });
	assert.equal(found?.pr.number, 7);
	assert.equal(found?.summary, "failing");
	assert.ok(seen.every((call) => call.auth === `Bearer ${TOKEN}`));
	assert.ok(!JSON.stringify(found).includes(TOKEN));
});

// ---- D1/D2/D3/D4 da auditoria F9 ----
const NETWORK = /\b(push|fetch|ls-remote)\b/;
const LOCAL_GIT = /\b(status|rev-list|diff|rev-parse|symbolic-ref|log)\b/;

test("D1: o token só vai no comando de rede, sem hooks, fsmonitor nem helper de credencial do repositório e com --no-verify", async () => {
	const r = rig({ respond: (job) => (isPrJob(job) ? { stdout: PR_REPLY("abc123") } : undefined) });
	const sessionId = await open(r);
	await r.run("A", CODE_KINDS.push, { sessionId });
	await r.run("A", CODE_KINDS.prPrepare, { sessionId });
	const withToken = r.jobs.filter((j) => j.env.GH_TOKEN || j.env.GITHUB_TOKEN);
	assert.ok(withToken.length >= 2 && withToken.some((j) => /\bfetch\b/.test(j.cmd) && j.cmd.includes("ls-remote")), "push, fetch e ls-remote usam a credencial");
	for (const job of withToken) {
		assert.match(job.cmd, NETWORK, `job com token tem de ser de rede: ${job.cmd.slice(0, 60)}`);
		assert.ok(!LOCAL_GIT.test(job.cmd), `git local com token: ${job.cmd}`);
		for (const flag of ["core.hooksPath=/dev/null", "core.fsmonitor=false", "credential.helper="]) assert.ok(job.cmd.includes(flag), `${flag} em ${job.cmd}`);
	}
	assert.ok(withToken.some((j) => /\bpush\b/.test(j.cmd) && j.cmd.includes("--no-verify")));
	for (const job of r.jobs.filter((j) => !j.env.GH_TOKEN)) assert.ok(!NETWORK.test(job.cmd), `rede sem token: ${job.cmd.slice(0, 60)}`);
});

test("D2: push, fetch e ls-remote vão para a URL do repositório da SESSÃO, nunca para `origin` (que o repositório pode ter reapontado)", async () => {
	const r = rig({ respond: (job) => (isPrJob(job) ? { stdout: PR_REPLY("abc123") } : undefined) });
	const sessionId = await open(r);
	await r.run("A", CODE_KINDS.push, { sessionId });
	await r.run("A", CODE_KINDS.prPrepare, { sessionId });
	const network = r.jobs.filter((j) => j.env.GH_TOKEN);
	assert.ok(network.length >= 2);
	for (const job of network) {
		assert.equal(job.env.DEV_REMOTE_URL, "https://github.com/acme/loja.git");
		assert.ok(job.cmd.includes('"$DEV_REMOTE_URL"'), job.cmd);
		assert.ok(!/\borigin\b/.test(job.cmd.replace(/origin\//g, "")), `usa origin: ${job.cmd}`);
	}
});

test("D4: a base do PR começando com hífen é recusada e o fetch usa refspec explícito", async () => {
	const r = rig();
	const sessionId = await open(r);
	const bad = await r.run("A", CODE_KINDS.prPrepare, { sessionId, base: "--upload-pack=touch" });
	assert.equal(bad.ok, false);
	assert.match(bad.error ?? "", /unsupported base branch/);
	assert.equal(r.jobs.some((j) => NETWORK.test(j.cmd)), false);
	const fine = rig({ respond: (job) => (isPrJob(job) ? { stdout: PR_REPLY("") } : undefined) });
	const id = await open(fine);
	await fine.run("A", CODE_KINDS.prPrepare, { sessionId: id, base: "develop" });
	const fetch = fine.jobs.find((j) => /\bfetch\b/.test(j.cmd))!;
	assert.ok(fetch.cmd.includes('"+refs/heads/$DEV_BASE:refs/remotes/origin/$DEV_BASE"'), fetch.cmd);
});

test("D3: a lista do stage sai com quotePath desligado e separada por NUL; segredo de qualquer tipo ou caminho de CI/hook recusa e desfaz o stage", async () => {
	for (const [names, expected] of [
		["src/a.js\ncerts/server.pem\n", /secret files .*server\.pem/],
		["src/a.js\nde/.env\n", /secret files .*\.env/],
		["src/a.js\n.github/workflows/deploy.yml\n", /by hand/],
		["src/a.js\n.husky/pre-commit\n", /by hand/],
	] as const) {
		const r = rig({ respond: (job) => (job.cmd.includes("diff --cached --name-only") ? { stdout: names } : undefined) });
		const sessionId = await open(r);
		const res = await r.run("A", CODE_KINDS.commit, { sessionId, message: "x", branch: "fix/a" });
		assert.equal(res.ok, false, names);
		assert.match(res.error ?? "", expected);
		assert.equal(r.jobs.some((j) => j.cmd.includes("git commit")), false);
		assert.equal(r.jobs.some((j) => j.cmd.includes("git reset -q")), true);
		const stage = r.jobs.find((j) => j.cmd.includes("diff --cached --name-only"))!;
		assert.ok(stage.cmd.includes("core.quotePath=false") && stage.cmd.includes("-z"), stage.cmd);
	}
});

test("D3: push verifica os arquivos dos commits que ainda não estão no GitHub e recusa segredo ou caminho de CI, sem usar o token", async () => {
	for (const [files, expected] of [
		[".env\nsrc/a.ts\n", /secret files .*\.env/],
		["src/a.ts\n.github/workflows/x.yml\n", /by hand/],
	] as const) {
		const r = rig({ respond: (job) => (job.cmd.includes("--not --remotes") ? { stdout: files } : undefined) });
		const sessionId = await open(r);
		const res = await r.run("A", CODE_KINDS.push, { sessionId });
		assert.equal(res.ok, false, files);
		assert.match(res.error ?? "", expected);
		assert.match(res.error ?? "", /Nothing was pushed/);
		assert.equal(r.jobs.some((j) => isPush(j)), false);
		assert.equal(r.jobs.some((j) => j.env.GH_TOKEN), false);
	}
	const clean = rig({ respond: (job) => (job.cmd.includes("--not --remotes") ? { stdout: "src/a.ts\nREADME.md\n" } : undefined) });
	const id = await open(clean);
	assert.equal((await clean.run("A", CODE_KINDS.push, { sessionId: id })).ok, true);
	const failing = rig({ respond: (job) => (job.cmd.includes("--not --remotes") ? { exitCode: 128, stdout: "fatal" } : undefined) });
	const f = await open(failing);
	const res = await failing.run("A", CODE_KINDS.push, { sessionId: f });
	assert.equal(res.ok, false);
	assert.match(res.error ?? "", /Could not check the commits/);
	assert.equal(failing.jobs.some((j) => isPush(j)), false);
});
