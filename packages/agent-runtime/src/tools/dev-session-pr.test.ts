import { describe, expect, it, vi } from "vitest";
import type { DevClient, DevEndpoint, DevExecSnapshot, DevSandboxProvider } from "@workspace/sandbox";
import { loadDevSandboxConfig } from "@workspace/sandbox";
import type { DevSessionEvent, EffectiveAutonomy } from "@workspace/shared";
import { decideAction } from "@workspace/shared";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCiLogsArgs, parseCiStatusArgs, parsePrCheckoutArgs, parsePrCreateArgs } from "./dev-session-args.js";
import {
	createDevSessionRuntime,
	DEV_SESSION_TOOLS,
	devSessionAllowedForOrigin,
	devSessionAutonomyMeta,
	type DevPrGate,
	type DevSessionRow,
	type DevSessionStore,
} from "./dev-session.js";
import { fetchJobLog, fetchPullSnapshot, mapCheckRuns, tailJobLog } from "../github/pull-ci.js";

const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

describe("argumentos de PR e CI", () => {
	it("dev_pr_create exige título e corpo, normaliza o título e valida a base", () => {
		expect(parsePrCreateArgs({ title: "  Corrige   o login ", body: "texto" })).toEqual({ title: "Corrige o login", body: "texto", draft: false });
		expect(parsePrCreateArgs({ title: "t", body: "", base: "develop", draft: true })).toMatchObject({ base: "develop", draft: true });
		expect(() => parsePrCreateArgs({ body: "x" })).toThrow(/title/);
		expect(() => parsePrCreateArgs({ title: "t" })).toThrow(/body/);
		expect(() => parsePrCreateArgs({ title: "t", body: "b", base: "--force" })).toThrow(/base/);
		expect(() => parsePrCreateArgs({ title: "t", body: "b", draft: "sim" })).toThrow(/draft/);
		expect(() => parsePrCreateArgs({ title: "x".repeat(300), body: "b" })).toThrow(/title/);
	});
	it("dev_pr_checkout aceita número, #número e URL (que também define o repo)", () => {
		expect(parsePrCheckoutArgs({ number: 42 })).toEqual({ number: 42 });
		expect(parsePrCheckoutArgs({ number: "#42" })).toEqual({ number: 42 });
		expect(parsePrCheckoutArgs({ number: "https://github.com/octo/hello/pull/7/files" })).toEqual({ number: 7, repo: "octo/hello" });
		expect(parsePrCheckoutArgs({ number: "7", repo: "octo/other" })).toEqual({ number: 7, repo: "octo/other" });
		expect(() => parsePrCheckoutArgs({ number: "abc" })).toThrow(/número/);
		expect(() => parsePrCheckoutArgs({ number: 0 })).toThrow(/número/);
		expect(() => parsePrCheckoutArgs({})).toThrow(/número/);
		expect(() => parsePrCheckoutArgs({ number: "1; rm -rf /" })).toThrow();
	});
	it("dev_ci_status e dev_ci_logs têm padrões e limites", () => {
		expect(parseCiStatusArgs({})).toEqual({});
		expect(parseCiStatusArgs({ number: "9" })).toEqual({ number: 9 });
		expect(parseCiLogsArgs({})).toEqual({ maxChars: 6_000 });
		expect(parseCiLogsArgs({ jobId: 55, maxChars: 1000 })).toEqual({ jobId: 55, maxChars: 1000 });
		expect(() => parseCiLogsArgs({ jobId: 1, runId: 2 })).toThrow(/OU/);
		expect(() => parseCiLogsArgs({ jobId: -3 })).toThrow(/jobId/);
		expect(() => parseCiLogsArgs({ maxChars: 99_999 })).toThrow(/maxChars/);
	});
});

describe("autonomia de PR", () => {
	const policy = (level: string, exceptions: unknown[] = []) => ({ level, exceptions }) as unknown as EffectiveAutonomy;
	it("criar PR é escrita externa: só o nível Autônomo executa sem perguntar", () => {
		const meta = devSessionAutonomyMeta("dev_pr_create");
		expect(meta).toEqual({ actionClass: "write", tool: "dev_pr_create", host: false });
		expect(decideAction(policy("balanced"), meta)).toBe("ask");
		expect(decideAction(policy("always_ask"), meta)).toBe("ask");
		expect(decideAction(policy("autonomous"), meta)).toBe("allow");
		expect(decideAction(policy("autonomous", [{ tool: "dev_pr_create", mode: "always_ask" }]), meta)).toBe("ask");
		expect(decideAction(policy("balanced", [{ tool: "dev_pr_create", mode: "blocked" }]), meta)).toBe("block");
	});
	it("checkout é local (sem perguntar no Equilibrado) e CI é leitura", () => {
		expect(decideAction(policy("balanced"), devSessionAutonomyMeta("dev_pr_checkout"))).toBe("allow");
		expect(devSessionAutonomyMeta("dev_ci_status").actionClass).toBe("read");
		expect(devSessionAutonomyMeta("dev_ci_logs").actionClass).toBe("read");
	});
	it("webhook e subagente só recebem as tools de CI (leitura)", () => {
		expect(devSessionAllowedForOrigin("dev_pr_create", "webhook")).toBe(false);
		expect(devSessionAllowedForOrigin("dev_pr_checkout", "subagent")).toBe(false);
		expect(devSessionAllowedForOrigin("dev_ci_status", "webhook")).toBe(true);
	});
	it("as tools novas têm schema, sem citar o nome do produto", () => {
		const names = DEV_SESSION_TOOLS.map((t) => t.function.name);
		for (const name of ["dev_pr_create", "dev_pr_checkout", "dev_ci_status", "dev_ci_logs"]) expect(names).toContain(name);
		const create = DEV_SESSION_TOOLS.find((t) => t.function.name === "dev_pr_create")!;
		expect((create.function.parameters as { required: string[] }).required).toEqual(["title", "body"]);
		expect(JSON.stringify(DEV_SESSION_TOOLS)).not.toMatch(/atlas/i);
	});
});

describe("migração", () => {
	it("20261023120000_dev_session_pr é aditiva (só ADD COLUMN opcional) e vem depois da última", () => {
		const dir = fileURLToPath(new URL("../../../db/prisma/migrations/", import.meta.url));
		const names = readdirSync(dir).filter((n) => /^\d{14}_/.test(n)).sort();
		const index = names.indexOf("20261023120000_dev_session_pr");
		expect(index).toBeGreaterThan(0);
		const sql = readFileSync(`${dir}20261023120000_dev_session_pr/migration.sql`, "utf8");
		const statements = sql
			.split("\n")
			.map((line) => line.trimEnd())
			.filter((line) => line.trim() && !line.trim().startsWith("--"));
		expect(statements.length).toBe(7);
		for (const line of statements) {
			expect(line).toMatch(/^ALTER TABLE "dev_sessions" ADD COLUMN "pr[A-Za-z]+" (INTEGER|TEXT);$/);
			expect(line).not.toMatch(/NOT NULL|DROP|DEFAULT/);
		}
	});
});

// ---------------------------------------------------------------------------
// API do GitHub simulada
// ---------------------------------------------------------------------------

type Call = { url: string; method: string; auth: string | null; body?: unknown };

function fakeGithub(routes: Record<string, (call: Call) => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }>) {
	const calls: Call[] = [];
	const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const headers = new Headers(init?.headers);
		const call: Call = { url, method: init?.method ?? "GET", auth: headers.get("authorization"), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
		calls.push(call);
		const key = Object.keys(routes).find((route) => url.includes(route));
		if (!key) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
		const out = routes[key]!(call);
		return new Response(out.text ?? JSON.stringify(out.json ?? {}), { status: out.status ?? 200, headers: out.headers });
	});
	return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

const PULL = {
	number: 42,
	html_url: "https://github.com/octo/hello/pull/42",
	state: "open",
	draft: false,
	merged: false,
	title: "Corrige o login",
	head: { ref: "fix/login", sha: "abcdef1234567890" },
	base: { ref: "main" },
};

const CHECK_RUNS = {
	check_runs: [
		{ name: "build", status: "completed", conclusion: "success", html_url: "https://github.com/octo/hello/actions/runs/1/job/11", details_url: "https://github.com/octo/hello/actions/runs/1/job/11", started_at: "2026-10-19T10:00:00Z", completed_at: "2026-10-19T10:01:02Z" },
		{ name: "test", status: "completed", conclusion: "failure", html_url: "https://github.com/octo/hello/actions/runs/1/job/12", details_url: "https://github.com/octo/hello/actions/runs/1/job/12", started_at: "2026-10-19T10:00:00Z", completed_at: "2026-10-19T10:03:00Z" },
		{ name: "lint", status: "in_progress", conclusion: null, html_url: "https://github.com/octo/hello/actions/runs/1/job/13", started_at: "2026-10-19T10:00:00Z" },
		{ name: "docs", status: "completed", conclusion: "skipped" },
		{ name: "build", status: "completed", conclusion: "failure" },
	],
};

describe("CI: mapeamento", () => {
	it("mapeia check runs e status legados sem repetir nomes", () => {
		const checks = mapCheckRuns(CHECK_RUNS, { statuses: [{ context: "deploy/preview", state: "pending", target_url: "https://x.test/d" }, { context: "test", state: "success" }, { context: "cov", state: "error" }] });
		expect(checks.map((c) => c.name)).toEqual(["build", "test", "lint", "docs", "deploy/preview", "cov"]);
		expect(checks[0]).toMatchObject({ name: "build", status: "completed", conclusion: "success", durationMs: 62_000, jobId: 11 });
		expect(checks[2]).toMatchObject({ status: "in_progress", conclusion: null });
		expect(checks[4]).toMatchObject({ status: "in_progress", conclusion: null, url: "https://x.test/d" });
		expect(checks[5]).toMatchObject({ status: "completed", conclusion: "failure" });
	});
});

describe("CI: snapshot, logs e redação", () => {
	it("lê o PR e os checks; sem token, não manda Authorization", async () => {
		const gh = fakeGithub({
			"/pulls/42": () => ({ json: PULL }),
			"/check-runs": () => ({ json: CHECK_RUNS }),
			"/status": () => ({ json: { statuses: [] } }),
		});
		const snap = await fetchPullSnapshot(undefined, "octo/hello", 42, { fetchFn: gh.fetchFn });
		expect("error" in snap).toBe(false);
		if ("error" in snap) return;
		expect(snap.pr).toMatchObject({ number: 42, state: "open", base: "main", head: "fix/login", headSha: "abcdef1234567890" });
		expect(snap.summary).toBe("failing");
		expect(gh.calls.every((c) => c.auth === null)).toBe(true);
	});
	it("PR mesclado e rascunho viram estados próprios", async () => {
		const merged = fakeGithub({ "/pulls/42": () => ({ json: { ...PULL, state: "closed", merged: true } }), "/check-runs": () => ({ json: { check_runs: [] } }), "/status": () => ({ json: {} }) });
		const snap = await fetchPullSnapshot(TOKEN, "octo/hello", 42, { fetchFn: merged.fetchFn });
		expect("error" in snap ? "erro" : snap.pr.state).toBe("merged");
		expect("error" in snap ? "erro" : snap.summary).toBe("none");
		const draft = fakeGithub({ "/pulls/42": () => ({ json: { ...PULL, draft: true } }), "/check-runs": () => ({ json: { check_runs: [] } }), "/status": () => ({ json: {} }) });
		const d = await fetchPullSnapshot(TOKEN, "octo/hello", 42, { fetchFn: draft.fetchFn });
		expect("error" in d ? "erro" : d.pr.state).toBe("draft");
	});
	it("404 volta como erro estruturado", async () => {
		const gh = fakeGithub({});
		const snap = await fetchPullSnapshot(TOKEN, "octo/none", 1, { fetchFn: gh.fetchFn });
		expect(snap).toMatchObject({ error: { status: 404 } });
	});
	it("tailJobLog tira timestamps e ANSI, mantém o fim e destaca ##[error]", () => {
		const raw = [
			...Array.from({ length: 400 }, (_, i) => `2026-10-19T10:00:00.1234567Z linha ${i}`),
			"2026-10-19T10:00:01.0000000Z \u001b[31mFAIL\u001b[0m src/a.test.ts",
			"2026-10-19T10:00:02.0000000Z ##[error]Process completed with exit code 1.",
		].join("\n");
		const out = tailJobLog(raw, 500);
		expect(out).toContain("Erros anotados:\nProcess completed with exit code 1.");
		expect(out).toContain("[início do log omitido]");
		expect(out).toContain("FAIL src/a.test.ts");
		expect(out).not.toMatch(/\u001b|2026-10-19T/);
		expect(out.length).toBeLessThan(900);
	});
	it("o log vem por redirecionamento e o token NÃO vai para o segundo endereço", async () => {
		const gh = fakeGithub({
			"/actions/jobs/12/logs": () => ({ status: 302, headers: { location: "https://blob.example.test/log.txt?sig=abc" } }),
			"blob.example.test": () => ({ text: "2026-10-19T10:00:00Z erro: boom" }),
		});
		const log = await fetchJobLog(TOKEN, "octo/hello", 12, { fetchFn: gh.fetchFn });
		expect(log).toContain("boom");
		expect(gh.calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
		expect(gh.calls[1]!.auth).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Runtime com container simulado
// ---------------------------------------------------------------------------

function snap(partial: Partial<DevExecSnapshot>): DevExecSnapshot {
	return { id: "0123456789ab", status: "exited", running: false, exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", nextOut: 0, nextErr: 0, truncated: false, omittedBytes: 0, durationMs: 800, cwd: "/workspace", ...partial };
}

function setup(options: {
	pr?: DevSessionRow["pr"];
	inspect?: string;
	push?: Partial<DevExecSnapshot>;
	checkout?: Partial<DevExecSnapshot>;
	gate?: Partial<DevPrGate> | null;
	decision?: "allow" | "ask" | "block";
	approved?: boolean;
	github?: ReturnType<typeof fakeGithub>;
	token?: string | null;
	repo?: string | null;
}) {
	const events: DevSessionEvent[] = [];
	const execs: Array<{ cmd: string; env?: Record<string, string> }> = [];
	const outputs = new Map<string, DevExecSnapshot>();
	const client = {
		execStart: vi.fn(async (input: { cmd: string; env?: Record<string, string> }) => {
			execs.push(input);
			const id = `${String(execs.length).padStart(12, "0")}`;
			const out = input.cmd.includes("rev-parse --abbrev-ref")
				? snap({ stdout: options.inspect ?? "head=fix/login\nbase=main\ndirty=0\nahead=2\nfiles=3\nsha=abc\n" })
				: input.cmd.includes("git push")
					? snap({ ...options.push })
					: input.cmd.includes("refs/pull/")
						? snap({ stdout: "ok\n", ...options.checkout })
						: snap({});
			outputs.set(id, { ...out, id });
			return { id };
		}),
		execPoll: vi.fn(async (id: string) => outputs.get(id) ?? snap({})),
		setEgress: vi.fn(async (policy: unknown) => policy),
	};
	const endpoint: DevEndpoint = { baseUrl: "http://x:3090", token: "t" };
	const provider = {
		ensureRunning: vi.fn(async () => ({ status: "running" as const, endpoint, containerId: "cid", resumed: false })),
		stop: vi.fn(),
		destroy: vi.fn(),
		inspect: vi.fn(),
		endpoint: vi.fn(),
		runningJobs: vi.fn(),
	} as unknown as DevSandboxProvider;
	const row: DevSessionRow = {
		id: "s1",
		userId: "u1",
		conversationId: "c1",
		repo: options.repo === undefined ? "octo/hello" : options.repo,
		branch: "fix/login",
		baseBranch: "main",
		status: "RUNNING",
		tier: "small",
		containerId: "cid",
		todos: [],
		pr: options.pr ?? null,
	};
	const store: DevSessionStore = {
		create: vi.fn(),
		findForConversation: vi.fn(async () => ({ ...row })),
		update: vi.fn(async (_id, patch) => {
			Object.assign(row, patch);
		}),
	};
	const requested: Array<Record<string, unknown>> = [];
	const gate: DevPrGate | undefined =
		options.gate === null
			? undefined
			: {
					decide: () => options.decision ?? "ask",
					findApproved: async () => options.approved === true,
					requestApproval: async (input) => {
						requested.push(input);
						return { type: "confirm", confirmId: "confirm-r1", title: "Criar pull request?", description: input.description, confirmLabel: "Criar PR", cancelLabel: "Agora não", callKey: input.callKey };
					},
					...options.gate,
				};
	const runtime = createDevSessionRuntime({
		userId: "u1",
		conversationId: "c1",
		provider,
		config: loadDevSandboxConfig({ DEV_SANDBOX_ENABLED: "true" }),
		store,
		emit: (event) => {
			events.push(event);
		},
		getGithubToken: async () => (options.token === null ? { error: "Conecte o GitHub no Marketplace" } : { token: options.token ?? TOKEN }),
		makeClient: () => client as unknown as DevClient,
		sleep: async () => undefined,
		queueWaitMs: 0,
		prGate: gate,
		githubFetch: options.github?.fetchFn,
	});
	return { runtime, events, execs, client, store, requested, getRow: () => row };
}

const prGithub = () =>
	fakeGithub({
		"/pulls?state=open": () => ({ json: [] }),
		"/pulls/42": () => ({ json: PULL }),
		"/check-runs": () => ({ json: CHECK_RUNS }),
		"/status": () => ({ json: { statuses: [] } }),
		"/pulls": (call) => ({ status: 201, json: { ...PULL, title: (call.body as { title: string }).title } }),
	});

const ARGS = { title: "Corrige o login", body: "## O que\nCorrige.", base: "main" };

describe("dev_pr_create", () => {
	it("sem o gate de confirmação recusa (nunca publica sozinho)", async () => {
		const t = setup({ gate: null });
		await expect(t.runtime.execute("dev_pr_create", ARGS, "c")).rejects.toThrow(/confirmação/);
		expect(t.execs).toHaveLength(0);
	});
	it("bloqueado pela autonomia: erro e nada roda", async () => {
		const t = setup({ decision: "block" });
		await expect(t.runtime.execute("dev_pr_create", ARGS, "c")).rejects.toThrow(/bloqueado/);
		expect(t.execs).toHaveLength(0);
	});
	it("pergunta: devolve o cartão com título, base ← head e arquivos, e não faz push nem chama a API", async () => {
		const github = prGithub();
		const t = setup({ decision: "ask", github });
		const result = await t.runtime.execute("dev_pr_create", ARGS, "c");
		expect(result.confirmEvent).toMatchObject({ type: "confirm", confirmLabel: "Criar PR", cancelLabel: "Agora não" });
		expect(result.confirmEvent?.description).toBe("Corrige o login\nmain ← fix/login\n3 arquivos alterados · 2 commits");
		expect(result.summary).toMatch(/Nada foi publicado/);
		expect(t.requested).toHaveLength(1);
		expect(t.requested[0]).toMatchObject({ base: "main", head: "fix/login", sessionId: "s1" });
		expect(t.execs.some((e) => e.cmd.includes("git push"))).toBe(false);
		expect(github.calls).toHaveLength(0);
	});
	it("aprovado: faz push com GH_TOKEN só no env, abre o PR e emite dev_pr e dev_ci", async () => {
		const github = prGithub();
		const t = setup({ decision: "ask", approved: true, github });
		const result = await t.runtime.execute("dev_pr_create", ARGS, "c");
		expect(result.confirmEvent).toBeUndefined();
		expect(result.summary).toContain("PR criado: #42 https://github.com/octo/hello/pull/42");
		const push = t.execs.find((e) => e.cmd.includes("git push"))!;
		expect(push.cmd).not.toContain(TOKEN);
		expect(push.env).toMatchObject({ GH_TOKEN: TOKEN, DEV_HEAD: "fix/login" });
		const create = github.calls.find((c) => c.method === "POST")!;
		expect(create.auth).toBe(`Bearer ${TOKEN}`);
		expect(create.body).toEqual({ title: "Corrige o login", body: "## O que\nCorrige.", head: "fix/login", base: "main", draft: false });
		const types = t.events.map((e) => e.type);
		expect(types).toContain("dev_pr");
		expect(types).toContain("dev_ci");
		expect(t.events.find((e) => e.type === "dev_pr")).toMatchObject({ sessionId: "s1", number: 42, state: "open", base: "main", head: "fix/login" });
		expect(t.events.find((e) => e.type === "dev_ci")).toMatchObject({ summary: "failing" });
		expect(t.getRow().pr).toMatchObject({ number: 42, url: "https://github.com/octo/hello/pull/42" });
		expect(JSON.stringify(t.events)).not.toContain(TOKEN);
	});
	it("Autônomo (allow): publica sem cartão", async () => {
		const t = setup({ decision: "allow", approved: false, github: prGithub() });
		const result = await t.runtime.execute("dev_pr_create", { ...ARGS, draft: true }, "c");
		expect(result.confirmEvent).toBeUndefined();
		expect(t.requested).toHaveLength(0);
		expect(result.summary).toContain("#42");
	});
	it("chamada repetida reaproveita o PR aberto da branch em vez de criar outro", async () => {
		const github = fakeGithub({
			"/pulls?state=open": () => ({ json: [PULL] }),
			"/pulls/42": () => ({ json: PULL }),
			"/check-runs": () => ({ json: { check_runs: [] } }),
			"/status": () => ({ json: {} }),
		});
		const t = setup({ decision: "allow", github });
		const result = await t.runtime.execute("dev_pr_create", ARGS, "c");
		expect(result.summary).toContain("Já existia um PR aberto");
		expect(github.calls.some((c) => c.method === "POST")).toBe(false);
	});
	it("recusa branch base, alterações não commitadas e branch sem commits novos", async () => {
		await expect(setup({ inspect: "head=main\nbase=main\ndirty=0\nahead=0\nfiles=0\n" }).runtime.execute("dev_pr_create", ARGS, "c")).rejects.toThrow(/branch base/);
		await expect(setup({ inspect: "head=fix/x\nbase=main\ndirty=2\nahead=1\nfiles=1\n" }).runtime.execute("dev_pr_create", ARGS, "c")).rejects.toThrow(/não commitadas/);
		await expect(setup({ inspect: "head=fix/x\nbase=main\ndirty=0\nahead=0\nfiles=0\n" }).runtime.execute("dev_pr_create", ARGS, "c")).rejects.toThrow(/Nenhum commit novo/);
		await expect(setup({ inspect: "head=HEAD\nbase=main\ndirty=0\nahead=1\nfiles=1\n" }).runtime.execute("dev_pr_create", ARGS, "c")).rejects.toThrow(/HEAD solto/);
	});
	it("sem conexão do GitHub explica; falha de push não vaza o token", async () => {
		await expect(setup({ token: null }).runtime.execute("dev_pr_create", ARGS, "c")).rejects.toThrow(/Conecte o GitHub/);
		const t = setup({ decision: "allow", push: { exitCode: 128, stderr: `fatal: Authentication failed for https://x-access-token:${TOKEN}@github.com/octo/hello.git` } });
		await expect(t.runtime.execute("dev_pr_create", ARGS, "c")).rejects.toThrow(/git push/);
		await t.runtime.execute("dev_pr_create", ARGS, "c").catch((error: Error) => expect(error.message).not.toContain(TOKEN));
	});
	it("erro da API do GitHub aparece sem o token", async () => {
		const github = fakeGithub({
			"/pulls?state=open": () => ({ json: [] }),
			"/pulls": () => ({ status: 422, json: { message: `Validation Failed ${TOKEN}`, errors: [{ message: "A pull request already exists" }] } }),
		});
		const t = setup({ decision: "allow", github });
		const error = await t.runtime.execute("dev_pr_create", ARGS, "c").then(
			() => new Error("não falhou"),
			(e: Error) => e,
		);
		expect(error.message).toContain("Validation Failed");
		expect(error.message).toContain("already exists");
		expect(error.message).not.toContain(TOKEN);
	});
});

describe("dev_pr_checkout, dev_ci_status e dev_ci_logs", () => {
	it("faz o fetch de refs/pull e anexa o PR à sessão", async () => {
		const github = prGithub();
		const t = setup({ github });
		const { summary } = await t.runtime.execute("dev_pr_checkout", { number: "#42" }, "c");
		const checkout = t.execs.find((e) => e.cmd.includes("refs/pull/"))!;
		expect(checkout.env).toMatchObject({ DEV_PR: "42", DEV_LOCAL_BRANCH: "pr-42", GH_TOKEN: TOKEN });
		expect(summary).toContain("PR #42");
		expect(summary).toContain("COM FALHAS");
		expect(summary).toContain("✗ test");
		expect(summary).toContain("job=12");
		expect(t.getRow()).toMatchObject({ branch: "pr-42", baseBranch: "main" });
		expect(t.getRow().pr).toMatchObject({ number: 42 });
		expect(t.events.map((e) => e.type)).toEqual(expect.arrayContaining(["dev_pr", "dev_ci", "dev_session_status"]));
	});
	it("PR de outro repositório pede nova sessão; falha de git vira erro sem token", async () => {
		const t = setup({ github: prGithub() });
		await expect(t.runtime.execute("dev_pr_checkout", { number: "https://github.com/other/repo/pull/3" }, "c")).rejects.toThrow(/outra sessão/);
		const bad = setup({ github: prGithub(), checkout: { exitCode: 128, stderr: `fatal: couldn't find remote ref refs/pull/9/head ${TOKEN}` } });
		const error = await bad.runtime.execute("dev_pr_checkout", { number: 9 }, "c").then(() => new Error("x"), (e: Error) => e);
		expect(error.message).toMatch(/Não consegui fazer checkout/);
		expect(error.message).not.toContain(TOKEN);
	});
	it("dev_ci_status usa o PR da sessão, resume e emite dev_ci sem precisar do container", async () => {
		const github = prGithub();
		const t = setup({ github, pr: { number: 42, url: PULL.html_url, state: "open", title: "x", base: "main", head: "fix/login" } });
		const { summary } = await t.runtime.execute("dev_ci_status", {}, "c");
		expect(summary).toContain("CI: COM FALHAS (1 falhou · 2 de 4 passaram)");
		expect(summary).toContain("✓ build");
		expect(summary).toContain("… lint · em andamento");
		expect(t.execs).toHaveLength(0);
		const ci = t.events.find((e) => e.type === "dev_ci");
		expect(ci).toMatchObject({ type: "dev_ci", summary: "failing", sessionId: "s1" });
		expect(t.events.find((e) => e.type === "dev_pr")).toMatchObject({ headSha: "abcdef1234567890" });
	});
	it("dev_ci_status sem PR na sessão pede o número", async () => {
		const t = setup({ github: prGithub() });
		await expect(t.runtime.execute("dev_ci_status", {}, "c")).rejects.toThrow(/Nenhum PR/);
	});
	it("dev_ci_logs lê os jobs com falha do PR da sessão, com tail e redação", async () => {
		const github = fakeGithub({
			"/pulls/42": () => ({ json: PULL }),
			"/check-runs": () => ({ json: CHECK_RUNS }),
			"/status": () => ({ json: {} }),
			"/actions/jobs/12/logs": () => ({ status: 302, headers: { location: "https://blob.example.test/12" } }),
			"blob.example.test": () => ({ text: `2026-10-19T10:00:00Z FAIL a.test.ts\n2026-10-19T10:00:01Z ##[error]token vazou ${TOKEN}\n` }),
		});
		const t = setup({ github, pr: { number: 42, url: PULL.html_url, state: "open", title: "x", base: "main", head: "fix/login" } });
		const { summary } = await t.runtime.execute("dev_ci_logs", {}, "c");
		expect(summary).toContain("── test (job=12)");
		expect(summary).toContain("FAIL a.test.ts");
		expect(summary).not.toContain(TOKEN);
		expect(summary).toMatch(/dado não confiável|untrusted|não confiável/i);
	});
	it("dev_ci_logs com jobId direto e erro 403 explica sem vazar", async () => {
		const github = fakeGithub({ "/actions/jobs/77/logs": () => ({ status: 403, json: { message: "Must have admin rights to Repository." } }) });
		const t = setup({ github });
		const { summary } = await t.runtime.execute("dev_ci_logs", { jobId: 77 }, "c");
		expect(summary).toContain("job=77");
		expect(summary).toContain("Must have admin rights");
	});
});
