import { describe, expect, it, vi } from "vitest";
import type { DevClient, DevEndpoint, DevExecSnapshot, DevSandboxProvider } from "@workspace/sandbox";
import { computeEnvCacheKey, loadDevSandboxConfig } from "@workspace/sandbox";
import { CACHE_PROBE_SCRIPT, CACHE_RESTORE_SCRIPT, CACHE_SAVE_SCRIPT, CACHE_WIPE_SCRIPT } from "./dev-env-cache.js";
import { INSTALL_SCRIPT } from "./dev-environment.js";
import type { DevEnvironmentRuntime } from "./dev-environment.js";
import type { DevSessionEvent, EffectiveAutonomy } from "@workspace/shared";
import {
	capHeadTail,
	capResultText,
	isSafeRef,
	numberLines,
	parseEditFileArgs,
	parseGrepArgs,
	parseReadFileArgs,
	parseRepo,
	parseShellArgs,
	parseShellOutputArgs,
	parseStartArgs,
	parseWriteFileArgs,
	shq,
} from "./dev-session-args.js";
import {
	createDevSessionRuntime,
	DEV_SESSION_TOOLS,
	DEV_SESSION_TOOL_NAMES,
	devSessionAllowedForOrigin,
	devSessionAutonomyMeta,
	devSessionBlocked,
	type DevSessionRow,
	type DevSessionStore,
} from "./dev-session.js";

const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

describe("argumentos", () => {
	it("parseRepo aceita owner/name, URL https e ssh do GitHub", () => {
		expect(parseRepo("octo/hello")).toEqual({ url: "https://github.com/octo/hello.git", label: "octo/hello", dirName: "hello" });
		expect(parseRepo("https://github.com/octo/hello.git").label).toBe("octo/hello");
		expect(parseRepo("git@github.com:octo/hello.git").dirName).toBe("hello");
		expect(parseRepo("https://gitlab.com/g/p/proj").url).toBe("https://gitlab.com/g/p/proj.git");
	});
	it("parseRepo recusa credenciais, http e lixo", () => {
		expect(() => parseRepo("https://user:pw@github.com/a/b")).toThrow(/credenciais/);
		expect(() => parseRepo("http://github.com/a/b")).toThrow(/https/);
		expect(() => parseRepo("não é repo")).toThrow(/inválido/);
		expect(() => parseRepo("a/b; rm -rf /")).toThrow();
	});
	it("branches inseguras são recusadas", () => {
		for (const bad of ["-x", "a..b", "a b", "a;b", "$(x)", "x/", "a.lock", ""]) expect(isSafeRef(bad)).toBe(false);
		for (const ok of ["main", "feat/dev-sessions", "release-1.2"]) expect(isSafeRef(ok)).toBe(true);
	});
	it("parseStartArgs valida tier e exige repo com branch", () => {
		expect(parseStartArgs({ repo: "a/b", branch: "feat/x", tier: "medium" })).toMatchObject({ branch: "feat/x", tier: "medium" });
		expect(parseStartArgs({})).toEqual({});
		expect(() => parseStartArgs({ tier: "huge" })).toThrow(/tier/);
		expect(() => parseStartArgs({ branch: "x" })).toThrow(/repo/);
		expect(() => parseStartArgs({ repo: "a/b", branch: "--force" })).toThrow(/branch/);
	});
	it("parseShellArgs aplica padrões e limites", () => {
		expect(parseShellArgs({ cmd: "ls" })).toEqual({ cmd: "ls", cwd: undefined, timeoutMs: 30_000, background: false });
		expect(parseShellArgs({ cmd: "ls", timeout_ms: 600_000 })).toMatchObject({ timeoutMs: 600_000 });
		expect(() => parseShellArgs({ cmd: "ls", timeoutMs: 600_001 })).toThrow(/timeoutMs/);
		expect(parseShellArgs({ cmd: "ls", timeoutMs: 5000, background: true })).toMatchObject({ timeoutMs: 5000, background: true });
		expect(() => parseShellArgs({ cmd: "  " })).toThrow(/vazio/);
		expect(() => parseShellArgs({})).toThrow(/cmd/);
		expect(() => parseShellArgs({ cmd: "ls", timeoutMs: 10 })).toThrow(/timeoutMs/);
		expect(() => parseShellArgs({ cmd: "ls", background: "sim" })).toThrow(/background/);
	});
	it("shell_output exige jobId hexadecimal de 12 caracteres", () => {
		expect(parseShellOutputArgs({ jobId: "0123456789ab", offset: 0 })).toMatchObject({ jobId: "0123456789ab", offset: 0 });
		expect(() => parseShellOutputArgs({ jobId: "../etc" })).toThrow(/jobId/);
		expect(() => parseShellOutputArgs({ jobId: "0123456789ab", waitMs: 30_001 })).toThrow(/waitMs/);
		expect(parseShellOutputArgs({ jobId: "0123456789ab", until: "ready on port" })).toMatchObject({ until: "ready on port" });
	});
	it("read_file, write_file e edit_file validam", () => {
		expect(() => parseReadFileArgs({ path: "a", startLine: 5, endLine: 2 })).toThrow(/endLine/);
		expect(() => parseReadFileArgs({ path: "a", startLine: 0 })).toThrow(/startLine/);
		expect(parseWriteFileArgs({ path: "a", content: "" }).content).toBe("");
		expect(() => parseWriteFileArgs({ path: "a" })).toThrow(/content/);
		expect(() => parseEditFileArgs({ path: "a", old: "x", new: "x" })).toThrow(/iguais/);
		expect(() => parseEditFileArgs({ path: "a", old: "", new: "x" })).toThrow(/vazio/);
		expect(parseEditFileArgs({ path: "a", old: "x", new: "", replaceAll: true })).toMatchObject({ replaceAll: true });
		expect(() => parseGrepArgs({})).toThrow(/pattern/);
	});
	it("shq escapa aspas simples", () => {
		expect(shq("a'b")).toBe("'a'\\''b'");
	});
	it("capResultText mantém o fim e numberLines numera", () => {
		const out = capResultText(`${"x".repeat(100)}FIM`, 10);
		expect(out.endsWith("FIM")).toBe(true);
		expect(out).toMatch(/omitidos/);
		expect(numberLines("a\nb", 10)).toBe("    10\ta\n    11\tb");
	});
});

describe("tools e autonomia", () => {
	it("define as 11 tools pedidas, com schema", () => {
		expect(DEV_SESSION_TOOLS.map((t) => t.function.name)).toEqual([...DEV_SESSION_TOOL_NAMES]);
		const start = DEV_SESSION_TOOLS.find((t) => t.function.name === "dev_session_start")!;
		expect(Object.keys((start.function.parameters as { properties: object }).properties)).toEqual(["repo", "branch", "baseBranch", "tier"]);
		const todo = DEV_SESSION_TOOLS.find((t) => t.function.name === "todo_write")!;
		expect((todo.function.parameters as { required: string[] }).required).toEqual(["items"]);
	});
	it("nenhum texto de tool cita o nome do produto", () => {
		const text = JSON.stringify(DEV_SESSION_TOOLS);
		expect(text).not.toMatch(/atlas/i);
	});
	it("escrita é classe write com host:true; leitura é livre", () => {
		expect(devSessionAutonomyMeta("shell")).toEqual({ actionClass: "write", tool: "shell", host: true });
		expect(devSessionAutonomyMeta("edit_file").actionClass).toBe("write");
		for (const read of ["read_file", "list_files", "grep", "shell_output", "todo_write"] as const) {
			expect(devSessionAutonomyMeta(read).actionClass).toBe("read");
		}
	});
	it("exceção bloqueada tira a tool; webhook e subagente só leem", () => {
		const policy: EffectiveAutonomy = { level: "balanced", exceptions: [{ tool: "shell", mode: "blocked" }] } as EffectiveAutonomy;
		expect(devSessionBlocked(policy, "shell")).toBe(true);
		expect(devSessionBlocked(policy, "read_file")).toBe(false);
		expect(devSessionAllowedForOrigin("shell", "webhook")).toBe(false);
		expect(devSessionAllowedForOrigin("read_file", "subagent")).toBe(true);
		expect(devSessionAllowedForOrigin("write_file", "subagent")).toBe(false);
		expect(devSessionAllowedForOrigin("shell", "chat")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Runtime com provedor/cliente/store simulados
// ---------------------------------------------------------------------------

function snapshot(partial: Partial<DevExecSnapshot>): DevExecSnapshot {
	return {
		id: "0123456789ab",
		status: "exited",
		running: false,
		exitCode: 0,
		signal: null,
		timedOut: false,
		stdout: "",
		stderr: "",
		nextOut: 0,
		nextErr: 0,
		truncated: false,
		omittedBytes: 0,
		durationMs: 1200,
		cwd: "/workspace",
		...partial,
	};
}

function setup(options: { polls?: DevExecSnapshot[]; queued?: boolean; existing?: Partial<DevSessionRow> | null; token?: string | null; environment?: DevEnvironmentRuntime | null; config?: Partial<ReturnType<typeof loadDevSandboxConfig>>; execResult?: (cmd: string) => Partial<DevExecSnapshot>; autoEnv?: boolean; secretsGate?: boolean; now?: () => number; diagnostics?: boolean | { settleMs?: number; debounceMs?: number } } = {}) {
	const egressCalls: Array<{ mode: string; allowlist: string[] }> = [];
	const events: DevSessionEvent[] = [];
	const execStarts: Array<{ cmd: string; env?: Record<string, string>; cwd?: string }> = [];
	const served = new Set<number>();
	const polls = [...(options.polls ?? [snapshot({ stdout: "ok\n", nextOut: 3 })])];
	const client = {
		execStart: vi.fn(async (input: { cmd: string; env?: Record<string, string>; cwd?: string }) => {
			execStarts.push(input);
			return { id: "0123456789ab" };
		}),
		execPoll: vi.fn(async () => {
			if (options.execResult) {
				const index = execStarts.length - 1;
				const result = snapshot(options.execResult(execStarts[index]!.cmd));
				if (served.has(index)) return { ...result, stdout: "", stderr: "" };
				served.add(index);
				return result;
			}
			if (polls.length > 1) return polls.shift()!;
			const last = polls[0]!;
			// Depois da primeira leitura o servidor só devolve o que é novo.
			polls[0] = { ...last, stdout: "", stderr: "" };
			return last;
		}),
		execStdin: vi.fn(async () => ({ ok: true })),
		execKill: vi.fn(async () => ({ ok: true })),
		readFile: vi.fn(async () => ({ path: "/workspace/a.ts", kind: "text", size: 5, content: "uno\ndos", totalLines: 2, nextOffset: null, truncated: false })),
		writeFile: vi.fn(async (input: { path: string; content: string }) => ({ path: `/workspace/${input.path}`, created: true, bytes: input.content.length, diff: `+secret ${TOKEN}\n+linha`, added: 2, removed: 0 })),
		patchFile: vi.fn(async (input: { path: string }) => ({ path: `/workspace/${input.path}`, diff: "-a\n+b", added: 1, removed: 1 })),
		list: vi.fn(async () => ({ path: "/workspace", entries: [{ path: "src", type: "dir" as const, size: 0 }], total: 1, truncated: false })),
		grep: vi.fn(async () => ({ matches: "a.ts:1:foo", count: 1, totalFound: 1, truncated: false })),
		health: vi.fn(async () => ({ ok: true, runningJobs: 0 })),
		setEgress: vi.fn(async (policy: { mode: string; allowlist: string[] }) => {
			egressCalls.push(policy);
			return policy;
		}),
	};
	const endpoint: DevEndpoint = { baseUrl: "http://x:3090", token: "t" };
	const provider: DevSandboxProvider = {
		ensureRunning: vi.fn(async () =>
			options.queued
				? { status: "queued" as const, denied: { admit: false as const, reason: "max_concurrent" as const, message: "Já há 2 ambientes ativos." } }
				: { status: "running" as const, endpoint, containerId: "cid", resumed: false },
		),
		stop: vi.fn(),
		destroy: vi.fn(),
		inspect: vi.fn(),
		endpoint: vi.fn(),
		runningJobs: vi.fn(),
	};
	let row: DevSessionRow | null =
		options.existing === null
			? null
			: { id: "s1", userId: "u1", conversationId: "c1", repo: null, branch: null, baseBranch: null, status: "RUNNING", tier: "small", containerId: "cid", todos: [], ...options.existing };
	const updates: Array<Record<string, unknown>> = [];
	const savedEnvs = new Map<string, DevEnvironmentRuntime>();
	const gateCalls: Array<{ environmentId: string; repo: string; names: string[]; reason: string; title: string }> = [];
	const store: DevSessionStore = {
		create: vi.fn(async (input) => {
			row = { id: "s1", userId: input.userId, conversationId: input.conversationId, repo: input.repo ?? null, branch: input.branch ?? null, baseBranch: input.baseBranch ?? null, status: "CREATING", tier: input.tier, containerId: null, todos: [] };
			return row;
		}),
		findForConversation: vi.fn(async () => (row ? { ...row } : null)),
		update: vi.fn(async (_id, patch) => {
			updates.push(patch);
			if (row) Object.assign(row, patch);
		}),
	};
	const runtime = createDevSessionRuntime({
		userId: "u1",
		conversationId: "c1",
		provider,
		config: { ...loadDevSandboxConfig({ DEV_SANDBOX_ENABLED: "true" }), cacheEnabled: false, ...options.config },
		getEnvironment: async (_u: string, repo: string) => options.environment ?? savedEnvs.get(repo) ?? null,
		...(options.autoEnv
			? {
				environments: {
					createAuto: async (_u: string, repo: string, fields: { installCommand: string | null; startCommand: string | null; tier: DevEnvironmentRuntime["tier"]; commandAllowlist: string[] }) => {
						const env: DevEnvironmentRuntime = { id: "auto1", repo, ...fields, network: "allowlist", allowlist: [], secrets: { DB_URL: "valor-super-secreto-xyz" }, source: "auto", userEditedFields: [] };
						savedEnvs.set(repo, env);
						return env;
					},
					patch: async (_u: string, repo: string, patch: Partial<DevEnvironmentRuntime>) => {
						const next = { ...savedEnvs.get(repo)!, ...patch };
						savedEnvs.set(repo, next);
						return next;
					},
				},
			}
			: {}),
		...(options.secretsGate
			? {
				secretsGate: {
					request: async (input: { environmentId: string; repo: string; names: string[]; reason: string; title: string }) => {
						gateCalls.push(input);
						return { type: "confirm" as const, confirmId: "cf1", title: input.title };
					},
				},
			}
			: {}),
		store,
		emit: (event) => {
			events.push(event);
		},
		getGithubToken: async () => (options.token === null ? { error: "Conecte o GitHub no Marketplace" } : { token: options.token ?? TOKEN }),
		makeClient: () => client as unknown as DevClient,
		sleep: async () => undefined,
		queueWaitMs: 0,
		...(options.now ? { now: options.now } : {}),
		...(options.diagnostics !== undefined ? { afterEditDiagnostics: options.diagnostics } : {}),
	});
	return { runtime, events, client, provider, store, execStarts, updates, egressCalls, savedEnvs, gateCalls, getRow: () => row };
}

describe("runtime: dev_session_start", () => {
	it("cria a sessão, clona com GH_TOKEN só no env e emite os passos", async () => {
		const t = setup({ existing: null });
		const { summary } = await t.runtime.execute("dev_session_start", { repo: "octo/hello", branch: "feat/x", baseBranch: "main" }, "call1");
		expect(summary).toContain("RUNNING");
		expect(summary).toContain("/workspace/hello");
		const types = t.events.map((e) => (e.type === "dev_setup_step" ? `${e.step}:${e.status}` : e.type));
		expect(types).toEqual([
			"dev_session_status",
			"container:running",
			"dev_session_status",
			"container:done",
			"clone:running",
			"clone:done",
			"checkout:running",
			"checkout:done",
			"dev_session_status",
		]);
		const clone = t.execStarts[0]!;
		expect(clone.env).toMatchObject({ GH_TOKEN: TOKEN, DEV_REPO_URL: "https://github.com/octo/hello.git" });
		expect(clone.cmd).not.toContain(TOKEN);
		expect(JSON.stringify(t.events)).not.toContain(TOKEN);
		expect(t.execStarts[1]!.env).toMatchObject({ DEV_BRANCH: "feat/x", DEV_BASE: "main" });
		expect(t.getRow()).toMatchObject({ repo: "octo/hello", branch: "feat/x", baseBranch: "main", status: "RUNNING" });
		const status = t.events.find((e) => e.type === "dev_session_status");
		expect(status).toMatchObject({ sessionId: "s1", status: "CREATING", tier: "small" });
	});

	it("sem vaga devolve QUEUED sem clonar", async () => {
		const t = setup({ existing: null, queued: true });
		const { summary } = await t.runtime.execute("dev_session_start", { repo: "octo/hello" }, "c");
		expect(summary).toMatch(/QUEUED/);
		expect(t.execStarts).toHaveLength(0);
		expect(t.getRow()?.status).toBe("QUEUED");
		expect(t.events.some((e) => e.type === "dev_session_status" && e.status === "QUEUED")).toBe(true);
	});

	it("falha de clone mostra a dica do GitHub sem vazar o token", async () => {
		const t = setup({ existing: null, token: null, polls: [snapshot({ exitCode: 128, stderr: "fatal: could not read Username" })] });
		const { summary } = await t.runtime.execute("dev_session_start", { repo: "octo/private" }, "c");
		expect(summary).toContain("Falha ao clonar");
		expect(summary).toContain("Conecte o GitHub");
		expect(t.events.some((e) => e.type === "dev_setup_step" && e.step === "clone" && e.status === "failed" && e.exitCode === 128)).toBe(true);
	});
});

describe("runtime: shell", () => {
	it("primeiro plano: started, output e done na ordem, com token redigido", async () => {
		const t = setup({ polls: [snapshot({ stdout: `token=${TOKEN}\nok\n`, nextOut: 50, exitCode: 0 })] });
		const { summary } = await t.runtime.execute("shell", { cmd: "echo $GH_TOKEN" }, "call-9");
		expect(summary).toContain("exit 0");
		expect(summary).not.toContain(TOKEN);
		expect(t.execStarts[0]!.env).toMatchObject({ GH_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN });
		expect(t.events.map((e) => e.type)).toEqual(["shell_started", "shell_output", "shell_done"]);
		const [started, output, done] = t.events as [
			Extract<DevSessionEvent, { type: "shell_started" }>,
			Extract<DevSessionEvent, { type: "shell_output" }>,
			Extract<DevSessionEvent, { type: "shell_done" }>,
		];
		expect(started).toMatchObject({ callId: "call-9", jobId: "0123456789ab", cmd: "echo $GH_TOKEN", cwd: "/workspace" });
		expect(new Date(started.startedAt).toString()).not.toBe("Invalid Date");
		expect(output.chunk).not.toContain(TOKEN);
		expect(output.chunk).toContain("ok");
		expect(done).toMatchObject({ callId: "call-9", exitCode: 0, endedReason: "exit", durationMs: 1200 });
		expect(JSON.stringify(t.events)).not.toContain(TOKEN);
	});

	it("background devolve job_id e marca background_running", async () => {
		const t = setup({ polls: [snapshot({ running: true, status: "running", exitCode: null, stdout: "iniciando\n", nextOut: 9 })] });
		const { summary } = await t.runtime.execute("shell", { cmd: "pnpm install", background: true }, "c1");
		expect(summary).toContain("job_id=0123456789ab");
		expect(summary).toContain("shell_output");
		const done = t.events.find((e) => e.type === "shell_done");
		expect(done).toMatchObject({ endedReason: "background_running", exitCode: null });
	});

	it("background idêntico a um job rodando devolve o job existente, sem novo card", async () => {
		const t = setup({ polls: [snapshot({ running: true, status: "running", exitCode: null, stdout: "resolvendo", nextOut: 9, durationMs: 42_000 })] });
		t.client.execStart.mockResolvedValueOnce({ id: "aaaaaaaaaaaa", deduped: true, durationMs: 42_000 } as never);
		const { summary } = await t.runtime.execute("shell", { cmd: "pnpm install --frozen-lockfile", background: true }, "c1");
		expect(t.client.execStart).toHaveBeenCalledWith(expect.objectContaining({ dedupe: true }));
		expect(summary).toContain("idêntico já está rodando");
		expect(summary).toContain("job_id=aaaaaaaaaaaa");
		expect(t.events.some((e) => e.type === "shell_started" || e.type === "shell_done")).toBe(false);
	});

	it("tempo esgotado e código de saída diferente de zero aparecem no resultado e no evento", async () => {
		const t = setup({ polls: [snapshot({ exitCode: 143, timedOut: true, status: "timeout", stderr: "Terminated" })] });
		const { summary } = await t.runtime.execute("shell", { cmd: "sleep 999", timeoutMs: 1000 }, "c");
		expect(summary).toMatch(/TEMPO ESGOTADO/);
		expect(t.events.find((e) => e.type === "shell_done")).toMatchObject({ endedReason: "timeout" });
	});

	it("shell_output continua do cursor e fecha o card quando o job termina", async () => {
		const t = setup({ polls: [snapshot({ running: true, status: "running", exitCode: null, stdout: "a", nextOut: 1 })] });
		await t.runtime.execute("shell", { cmd: "x", background: true }, "c1");
		t.events.length = 0;
		t.client.execPoll.mockResolvedValueOnce(snapshot({ stdout: "b\n", nextOut: 3, exitCode: 0 }));
		const { summary } = await t.runtime.execute("shell_output", { jobId: "0123456789ab", waitMs: 0 }, "c2");
		expect(summary).toContain("terminou");
		expect(t.client.execPoll).toHaveBeenLastCalledWith("0123456789ab", expect.objectContaining({ out: 1 }));
		const done = t.events.find((e) => e.type === "shell_done");
		expect(done).toMatchObject({ callId: "c1", endedReason: "exit" });
	});

	it("shell_output espera por padrão 15s (long-poll) e devolve assim que o job termina", async () => {
		const t = setup({ polls: [snapshot({ running: true, status: "running", exitCode: null })] });
		await t.runtime.execute("shell", { cmd: "x", background: true }, "c1");
		t.client.execPoll.mockClear();
		t.client.execPoll.mockResolvedValueOnce(snapshot({ stdout: "fim\n", nextOut: 4, exitCode: 0 }));
		const { summary } = await t.runtime.execute("shell_output", { jobId: "0123456789ab" }, "c2");
		expect(summary).toContain("terminou");
		expect(t.client.execPoll).toHaveBeenCalledTimes(1);
		expect(t.client.execPoll).toHaveBeenCalledWith("0123456789ab", expect.objectContaining({ waitMs: 15_000 }));
	});

	it("shell_output devolve cedo com saída nova: uma janela curta de junção e volta, sem esperar o teto", async () => {
		const t = setup({ polls: [snapshot({ running: true, status: "running", exitCode: null })] });
		await t.runtime.execute("shell", { cmd: "x", background: true }, "c1");
		t.client.execPoll.mockClear();
		t.client.execPoll
			.mockResolvedValueOnce(snapshot({ running: true, status: "running", exitCode: null, stdout: "passo 1\n", nextOut: 8 }))
			.mockResolvedValueOnce(snapshot({ running: true, status: "running", exitCode: null, stdout: "passo 2\n", nextOut: 16 }));
		const { summary } = await t.runtime.execute("shell_output", { jobId: "0123456789ab", waitMs: 30_000 }, "c2");
		expect(summary).toContain("rodando");
		expect(summary).toContain("passo 1");
		expect(summary).toContain("passo 2");
		expect(t.client.execPoll).toHaveBeenCalledTimes(2);
		expect(t.client.execPoll.mock.calls[0]![1]).toMatchObject({ waitMs: 30_000 });
		expect(t.client.execPoll.mock.calls[1]![1]).toMatchObject({ waitMs: 750 });
	});

	it("shell_output sem saída nova espera pelo menos 5s mesmo com waitMs 0 (o modelo não gira em polls curtos)", async () => {
		let clock = 1_000_000;
		const t = setup({ polls: [snapshot({ running: true, status: "running", exitCode: null })], now: () => clock });
		// O servidor só volta no prazo quando não há saída nova: o relógio anda o que foi pedido.
		t.client.execPoll.mockImplementation((async (_id: string, input: { waitMs?: number }) => {
			clock += Math.max(input.waitMs ?? 0, 100);
			return snapshot({ running: true, status: "running", exitCode: null });
		}) as never);
		await t.runtime.execute("shell", { cmd: "x", background: true }, "c1");
		t.client.execPoll.mockClear();
		const { summary } = await t.runtime.execute("shell_output", { jobId: "0123456789ab", waitMs: 0 }, "c2");
		expect(summary).toContain("rodando");
		expect(t.client.execPoll).toHaveBeenCalledTimes(1);
		expect(t.client.execPoll).toHaveBeenCalledWith("0123456789ab", expect.objectContaining({ waitMs: 5_000 }));
	});

	it("shell_output tem teto de 30s", async () => {
		const t = setup({ polls: [snapshot({ running: true, status: "running", exitCode: null })] });
		await t.runtime.execute("shell", { cmd: "x", background: true }, "c1");
		t.client.execPoll.mockClear();
		t.client.execPoll.mockResolvedValueOnce(snapshot({ stdout: "fim\n", nextOut: 4, exitCode: 0 }));
		await t.runtime.execute("shell_output", { jobId: "0123456789ab", waitMs: 30_000 }, "c2");
		expect(t.client.execPoll).toHaveBeenCalledWith("0123456789ab", expect.objectContaining({ waitMs: 30_000 }));
	});

	it("shell_output com until faz uma única espera no servidor e volta quando a saída casa", async () => {
		const t = setup({ polls: [snapshot({ running: true, status: "running", exitCode: null })] });
		await t.runtime.execute("shell", { cmd: "x", background: true }, "c1");
		t.client.execPoll.mockClear();
		t.client.execPoll.mockResolvedValueOnce(snapshot({ running: true, status: "running", exitCode: null, stdout: "compilando\nready on port 3000\n", nextOut: 31, matched: true }));
		const { summary } = await t.runtime.execute("shell_output", { jobId: "0123456789ab", until: "ready on port" }, "c2");
		expect(t.client.execPoll).toHaveBeenCalledTimes(1);
		expect(t.client.execPoll).toHaveBeenCalledWith("0123456789ab", expect.objectContaining({ until: "ready on port", waitMs: 15_000 }));
		expect(summary).toContain("rodando");
		expect(summary).toContain("until casou");
		expect(summary).toContain("ready on port 3000");
	});

	it("shell_output com until que não casa até o prazo avisa e volta", async () => {
		const t = setup({ polls: [snapshot({ running: true, status: "running", exitCode: null })] });
		await t.runtime.execute("shell", { cmd: "x", background: true }, "c1");
		t.client.execPoll.mockClear();
		t.client.execPoll.mockResolvedValueOnce(snapshot({ running: true, status: "running", exitCode: null, stdout: "outra coisa\n", nextOut: 12, matched: false }));
		const { summary } = await t.runtime.execute("shell_output", { jobId: "0123456789ab", until: "Tests:" }, "c2");
		expect(t.client.execPoll).toHaveBeenCalledTimes(1);
		expect(summary).toContain("ainda não apareceu");
	});

	it("shell em primeiro plano que passa de 30s NÃO é morto: vira job e devolve still_running, job_id e o fim da saída", async () => {
		let clock = 1_000_000;
		const t = setup({ polls: [snapshot({ running: true, status: "running", exitCode: null })], now: () => clock });
		t.client.execPoll.mockImplementation((async (_id: string, input: { waitMs?: number }) => {
			clock += Math.max(input.waitMs ?? 0, 500);
			return snapshot({ running: true, status: "running", exitCode: null, stdout: "linha 1\nlinha 2\n", nextOut: 16, durationMs: 31_000 });
		}) as never);
		const { summary } = await t.runtime.execute("shell", { cmd: "pnpm build" }, "c1");
		expect(summary).toContain("still_running: true");
		expect(summary).toContain("job_id=0123456789ab");
		expect(summary).toContain("linha 2");
		expect(summary).toContain("hint: use shell_output");
		expect(summary).not.toMatch(/TEMPO ESGOTADO/);
		expect(t.execStarts).toHaveLength(1);
		// O job só morre no teto máximo, não no tempo de espera do primeiro plano.
		expect(t.client.execStart).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30 * 60_000 }));
		expect(t.client.execKill).not.toHaveBeenCalled();
		expect(clock - 1_000_000).toBeGreaterThanOrEqual(30_000);
		expect(clock - 1_000_000).toBeLessThan(40_000);
		// Ciclo de vida igual ao de background: o job fica aberto no painel (background_running).
		expect(t.events.find((e) => e.type === "shell_done")).toMatchObject({ endedReason: "background_running", exitCode: null });
	});

	it("timeoutMs maior espera mais antes de virar job", async () => {
		let clock = 1_000_000;
		const t = setup({ polls: [snapshot({ running: true, status: "running", exitCode: null })], now: () => clock });
		t.client.execPoll.mockImplementation((async (_id: string, input: { waitMs?: number }) => {
			clock += Math.max(input.waitMs ?? 0, 500);
			return snapshot({ running: true, status: "running", exitCode: null });
		}) as never);
		await t.runtime.execute("shell", { cmd: "pnpm test", timeoutMs: 120_000 }, "c1");
		expect(clock - 1_000_000).toBeGreaterThanOrEqual(120_000);
		expect(clock - 1_000_000).toBeLessThan(130_000);
	});

	it("capHeadTail guarda começo e fim com a marca de caracteres omitidos", () => {
		expect(capHeadTail("curto")).toEqual({ text: "curto", omitted: 0 });
		const big = "A".repeat(10_000) + "M".repeat(50_000) + "Z".repeat(20_000);
		const out = capHeadTail(big);
		expect(out.omitted).toBe(big.length - 30_000);
		expect(out.text.startsWith("AAAA")).toBe(true);
		expect(out.text.endsWith("ZZZZ")).toBe(true);
		expect(out.text).toContain(`[… ${out.omitted} caracteres omitidos …]`);
		expect(out.text.length).toBeLessThan(30_100);
	});

	it("saída acima de 30000 caracteres vem em começo+fim, com o caminho do arquivo completo", async () => {
		const big = "INICIO" + "x".repeat(60_000) + "FIM-DO-ERRO";
		const t = setup({ polls: [snapshot({ stdout: big, nextOut: big.length, exitCode: 1, spillPath: "/workspace/.agent/output/0123456789ab.txt" })] });
		const { summary } = await t.runtime.execute("shell", { cmd: "pnpm build" }, "c1");
		expect(summary).toContain("INICIO");
		expect(summary).toContain("FIM-DO-ERRO");
		expect(summary).toMatch(/\[… \d+ caracteres omitidos …\]/);
		expect(summary).toContain("/workspace/.agent/output/0123456789ab.txt");
		expect(summary.length).toBeLessThan(31_000);
	});

	it("saída pequena não ganha nota de arquivo mesmo com spillPath", async () => {
		const t = setup({ polls: [snapshot({ stdout: "ok\n", nextOut: 3, spillPath: "/workspace/.agent/output/0123456789ab.txt" })] });
		const { summary } = await t.runtime.execute("shell", { cmd: "echo ok" }, "c1");
		expect(summary).not.toContain(".agent/output");
	});

	it("shell_output também limita a 30000 caracteres e aponta o arquivo", async () => {
		const t = setup({ polls: [snapshot({ running: true, status: "running", exitCode: null })] });
		await t.runtime.execute("shell", { cmd: "x", background: true }, "c1");
		t.client.execPoll.mockResolvedValueOnce(snapshot({ stdout: "y".repeat(55_000), nextOut: 55_000, exitCode: 0, spillPath: "/workspace/.agent/output/0123456789ab.txt" }));
		const { summary } = await t.runtime.execute("shell_output", { jobId: "0123456789ab" }, "c2");
		expect(summary).toMatch(/caracteres omitidos/);
		expect(summary).toContain("/workspace/.agent/output/0123456789ab.txt");
	});

	it("saída gigante é limitada nos eventos", async () => {
		const big = "x".repeat(200_000);
		const t = setup({ polls: [snapshot({ stdout: big, nextOut: big.length })] });
		await t.runtime.execute("shell", { cmd: "cat big" }, "c");
		const chunks = t.events.filter((e) => e.type === "shell_output") as Array<{ chunk: string }>;
		const total = chunks.reduce((n, e) => n + e.chunk.length, 0);
		expect(total).toBeLessThan(70_000);
	});

	it("sem sessão pede dev_session_start; fila vira erro acionável", async () => {
		const none = setup({ existing: null });
		await expect(none.runtime.execute("shell", { cmd: "ls" }, "c")).rejects.toThrow(/dev_session_start/);
		const queued = setup({ queued: true, existing: { status: "STOPPED" } });
		await expect(queued.runtime.execute("shell", { cmd: "ls" }, "c")).rejects.toThrow(/fila/);
	});

	it("valida argumentos antes de tocar no container", async () => {
		const t = setup();
		await expect(t.runtime.execute("shell", { cmd: "" }, "c")).rejects.toThrow();
		expect(t.provider.ensureRunning).not.toHaveBeenCalled();
	});

	it("religa sessão parada antes de executar", async () => {
		const t = setup({ existing: { status: "STOPPED" } });
		await t.runtime.execute("shell", { cmd: "ls" }, "c");
		expect(t.provider.ensureRunning).toHaveBeenCalledOnce();
		expect(t.getRow()?.status).toBe("RUNNING");
		expect(t.events.some((e) => e.type === "dev_session_status" && e.status === "RUNNING")).toBe(true);
	});
});

describe("runtime: arquivos e tarefas", () => {
	it("write_file emite file_edit com diff redigido e contagens", async () => {
		const t = setup();
		const { summary } = await t.runtime.execute("write_file", { path: "a.ts", content: "x\ny" }, "cw");
		expect(summary).toContain("Criado");
		const edit = t.events.find((e) => e.type === "file_edit") as Extract<DevSessionEvent, { type: "file_edit" }>;
		expect(edit).toMatchObject({ callId: "cw", path: "/workspace/a.ts", added: 2, removed: 0 });
		expect(edit.diff).not.toContain(TOKEN);
	});

	it("edit_file passa old/new/replaceAll e emite file_edit", async () => {
		const t = setup();
		await t.runtime.execute("edit_file", { path: "a.ts", old: "a", new: "b", replaceAll: true }, "ce");
		expect(t.client.patchFile).toHaveBeenCalledWith({ path: "a.ts", old: "a", new: "b", replaceAll: true });
		expect(t.events[0]).toMatchObject({ type: "file_edit", callId: "ce", added: 1, removed: 1 });
	});

	it("erro do servidor (old não único) sobe como erro da tool", async () => {
		const t = setup();
		const { DevSandboxError } = await import("@workspace/sandbox");
		t.client.patchFile.mockRejectedValueOnce(new DevSandboxError("old aparece 2 vezes", 409));
		await expect(t.runtime.execute("edit_file", { path: "a", old: "x", new: "y" }, "c")).rejects.toThrow(/2 vezes/);
	});

	it("read_file numera linhas e avisa que o conteúdo não é confiável", async () => {
		const t = setup();
		const { summary } = await t.runtime.execute("read_file", { path: "a.ts", startLine: 10 }, "c");
		expect(t.client.readFile).toHaveBeenCalledWith({ path: "a.ts", offset: 9 });
		expect(summary).toContain("    10\tuno");
		expect(summary).toContain("    11\tdos");
	});

	it("list_files e grep formatam o resultado", async () => {
		const t = setup();
		expect((await t.runtime.execute("list_files", {}, "c")).summary).toContain("src/");
		expect((await t.runtime.execute("grep", { pattern: "foo" }, "c")).summary).toContain("a.ts:1:foo");
	});

	it("todo_write substitui, faz merge e emite todo_updated", async () => {
		const t = setup();
		await t.runtime.execute("todo_write", { items: [{ id: "1", content: "Ler código", status: "in_progress" }, { id: "2", content: "Rodar testes", status: "pending" }] }, "c");
		await t.runtime.execute("todo_write", { items: [{ id: "1", content: "Ler código", status: "completed" }, { id: "3", content: "Resumir", status: "pending" }], merge: true }, "c");
		const updates = t.events.filter((e) => e.type === "todo_updated") as Array<Extract<DevSessionEvent, { type: "todo_updated" }>>;
		expect(updates).toHaveLength(2);
		expect(updates[1]!.items.map((i) => `${i.id}:${i.status}`)).toEqual(["1:completed", "2:pending", "3:pending"]);
		expect(t.getRow()?.todos).toHaveLength(3);
		await expect(t.runtime.execute("todo_write", { items: [{ id: "1", content: "x", status: "feito" }] }, "c")).rejects.toThrow(/status/);
	});
});

describe("eventos carregam sessionId", () => {
	it("todos os eventos de sessão trazem o id da sessão", async () => {
		const t = setup({ polls: [snapshot({ stdout: "ok", nextOut: 2 })] });
		await t.runtime.execute("shell", { cmd: "ls" }, "c1");
		await t.runtime.execute("write_file", { path: "a.ts", content: "x" }, "c2");
		await t.runtime.execute("edit_file", { path: "a.ts", old: "x", new: "y" }, "c3");
		await t.runtime.execute("todo_write", { items: [{ id: "1", content: "a", status: "pending" }] }, "c4");
		const types = new Set(t.events.map((e) => e.type));
		for (const type of ["shell_started", "shell_output", "shell_done", "file_edit", "todo_updated"]) expect(types.has(type as never)).toBe(true);
		for (const event of t.events) expect((event as { sessionId?: string }).sessionId).toBe("s1");
	});
});

describe("fase 4: contexto de compactação e lembrete da lista", () => {
	it("guarda arquivos alterados, últimas falhas e tarefas para a nota de compactação", async () => {
		const t = setup({ polls: [snapshot({ exitCode: 2, stderr: "TS2322 erro de tipo", nextErr: 20 })] });
		await t.runtime.attach();
		await t.runtime.execute("edit_file", { path: "a.ts", old: "a", new: "b" }, "ce");
		await t.runtime.execute("edit_file", { path: "a.ts", old: "b", new: "c" }, "ce2");
		await t.runtime.execute("shell", { cmd: "pnpm typecheck" }, "cs");
		await t.runtime.execute("todo_write", { items: [{ id: "1", content: "Corrigir tipos", status: "in_progress" }] }, "ct");
		const ctx = t.runtime.compactionContext();
		expect(ctx.sessionId).toBe("s1");
		expect(ctx.filesChanged).toEqual([{ path: "/workspace/a.ts", added: 2, removed: 2 }]);
		expect(ctx.failures).toHaveLength(1);
		expect(ctx.failures[0]).toMatchObject({ cmd: "pnpm typecheck", exitCode: 2 });
		expect(ctx.failures[0]!.tail).toContain("TS2322");
		expect(ctx.todos.map((i) => i.content)).toEqual(["Corrigir tipos"]);
	});

	it("attach devolve false sem sessão na conversa e true com sessão", async () => {
		expect(await setup({ existing: null }).runtime.attach()).toBe(false);
		expect(await setup().runtime.attach()).toBe(true);
	});

	it("depois de várias chamadas sem todo_write o resultado lembra de atualizar a lista", async () => {
		const { TODO_REMINDER_AFTER_CALLS } = await import("./dev-session.js");
		const t = setup();
		let last = "";
		for (let i = 0; i < TODO_REMINDER_AFTER_CALLS; i += 1) last = (await t.runtime.execute("list_files", { path: `/workspace/d${i}` }, `c${i}`)).summary;
		expect(last).toMatch(/todo_write/);
		await t.runtime.execute("todo_write", { items: [{ id: "1", content: "a", status: "pending" }] }, "ct");
		expect((await t.runtime.execute("list_files", {}, "cx")).summary).not.toMatch(/Lembrete/);
	});
});

// ---------------------------------------------------------------------------
// Ambiente do repositório: tier, segredos, instalação, inicialização e internet
// ---------------------------------------------------------------------------

const SECRET = "s3cr3t-valor-xyz";
const environment = (patch: Partial<DevEnvironmentRuntime> = {}): DevEnvironmentRuntime => ({
	id: "e1",
	repo: "octo/hello",
	installCommand: "pnpm install",
	startCommand: null,
	tier: "medium",
	network: "allowlist",
	allowlist: ["meu-registro.empresa.com"],
	secrets: { API_KEY: SECRET },
	...patch,
});

describe("runtime: ambiente do repositório", () => {
	it("usa o tier do ambiente; o pedido só reduz e o teto global vale", async () => {
		const a = setup({ existing: null, environment: environment({ tier: "medium" }) });
		await a.runtime.execute("dev_session_start", { repo: "octo/hello" }, "c");
		expect(a.getRow()?.tier).toBe("medium");

		const b = setup({ existing: null, environment: environment({ tier: "medium" }) });
		const { summary } = await b.runtime.execute("dev_session_start", { repo: "octo/hello", tier: "large" }, "c");
		expect(b.getRow()?.tier).toBe("medium");
		expect(summary).toMatch(/limitados a medium/);

		const c = setup({ existing: null, environment: environment({ tier: "medium" }) });
		await c.runtime.execute("dev_session_start", { repo: "octo/hello", tier: "small" }, "c");
		expect(c.getRow()?.tier).toBe("small");

		const d = setup({ existing: null, environment: environment({ tier: "large" }), config: { maxTier: "medium" } });
		await d.runtime.execute("dev_session_start", { repo: "octo/hello" }, "c");
		expect(d.getRow()?.tier).toBe("medium");
	});

	it("roda a instalação depois do clone, com segredos só no env e saída redigida", async () => {
		const t = setup({
			existing: null,
			environment: environment(),
			polls: [snapshot({ exitCode: 0 }), snapshot({ exitCode: 0, stdout: `instalado com ${SECRET}\n`, nextOut: 30 })],
		});
		const { summary } = await t.runtime.execute("dev_session_start", { repo: "octo/hello" }, "c");
		expect(summary).toContain("Instalação do ambiente concluída");
		const install = t.execStarts[1]!;
		expect(install.env).toMatchObject({ DEV_INSTALL_CMD: "pnpm install", API_KEY: SECRET, DEV_REPO_NAME: "hello" });
		expect(install.cmd).not.toContain(SECRET);
		const steps = t.events.filter((e) => e.type === "dev_setup_step").map((e) => `${(e as { step: string }).step}:${(e as { status: string }).status}`);
		expect(steps).toEqual(["container:running", "container:done", "clone:running", "clone:done", "install:running", "install:done"]);
		const done = t.events.find((e) => e.type === "dev_setup_step" && e.step === "install" && e.status === "done") as Extract<DevSessionEvent, { type: "dev_setup_step" }>;
		expect(done.output).toContain("[redacted]");
		expect(JSON.stringify(t.events)).not.toContain(SECRET);
	});

	it("falha de instalação vira nota, não derruba a sessão", async () => {
		const t = setup({ existing: null, environment: environment(), polls: [snapshot({ exitCode: 0 }), snapshot({ exitCode: 1, stderr: "ERR_PNPM_FETCH" })] });
		const { summary } = await t.runtime.execute("dev_session_start", { repo: "octo/hello" }, "c");
		expect(summary).toMatch(/Falha na instalação.*ERR_PNPM_FETCH/);
		expect(t.events.some((e) => e.type === "dev_setup_step" && e.step === "install" && e.status === "failed" && e.exitCode === 1)).toBe(true);
		expect(t.getRow()?.status).toBe("RUNNING");
	});

	it("comando de inicialização roda em segundo plano depois da instalação", async () => {
		const t = setup({
			existing: null,
			environment: environment({ startCommand: "pnpm dev" }),
			polls: [snapshot({ exitCode: 0 }), snapshot({ exitCode: 0 }), snapshot({ exitCode: 1 }), snapshot({ running: true, status: "running", exitCode: null, stdout: "ready\n", nextOut: 6 })],
		});
		const { summary } = await t.runtime.execute("dev_session_start", { repo: "octo/hello" }, "c");
		expect(summary).toMatch(/inicialização rodando em segundo plano: job_id=/);
		const start = t.execStarts.at(-1)!;
		expect(start.env).toMatchObject({ DEV_START_CMD: "pnpm dev" });
		expect(t.events.some((e) => e.type === "dev_setup_step" && e.step === "start" && e.status === "done")).toBe(true);
	});

	it("não reinicia o comando se ele já está vivo", async () => {
		const t = setup({
			existing: null,
			environment: environment({ installCommand: null, startCommand: "pnpm dev" }),
			polls: [snapshot({ exitCode: 0 }), snapshot({ exitCode: 0 })],
		});
		const { summary } = await t.runtime.execute("dev_session_start", { repo: "octo/hello" }, "c");
		expect(summary).toMatch(/já está em execução/);
		expect(t.execStarts).toHaveLength(2);
	});

	it("comandos do agente recebem os segredos e a saída é redigida", async () => {
		const t = setup({ existing: { repo: "octo/hello" }, environment: environment(), polls: [snapshot({ stdout: `key=${SECRET}\n`, nextOut: 20 })] });
		const { summary } = await t.runtime.execute("shell", { cmd: "echo $API_KEY" }, "c");
		expect(t.execStarts[0]!.env).toMatchObject({ API_KEY: SECRET });
		expect(summary).not.toContain(SECRET);
		expect(summary).toContain("[redacted]");
		expect(JSON.stringify(t.events)).not.toContain(SECRET);
	});

	it("política de internet: lista na preparação; off corta depois; full não aplica restrição", async () => {
		const allow = setup({ existing: null, environment: environment({ installCommand: null }) });
		await allow.runtime.execute("dev_session_start", { repo: "octo/hello" }, "c");
		expect(allow.egressCalls.every((p) => p.mode === "allowlist")).toBe(true);
		expect(allow.egressCalls[0]!.allowlist).toEqual(expect.arrayContaining(["github.com", "registry.npmjs.org", "meu-registro.empresa.com"]));

		const off = setup({ existing: null, environment: environment({ network: "off", installCommand: null }) });
		await off.runtime.execute("dev_session_start", { repo: "octo/hello" }, "c");
		expect(off.egressCalls.map((p) => p.mode)).toEqual(["allowlist", "off"]);

		const full = setup({ existing: null, environment: environment({ network: "full", installCommand: null }) });
		await full.runtime.execute("dev_session_start", { repo: "octo/hello" }, "c");
		expect(full.egressCalls.every((p) => p.mode === "full")).toBe(true);
	});

	it("se não consegue aplicar a lista, falha em vez de deixar aberto", async () => {
		const t = setup({ existing: null, environment: environment() });
		t.client.setEgress.mockRejectedValue(new Error("404"));
		await expect(t.runtime.execute("dev_session_start", { repo: "octo/hello" }, "c")).rejects.toThrow(/política de internet/);
	});

	it("dev_environment_get mostra comandos e só os nomes dos segredos", async () => {
		const t = setup({ existing: { repo: "octo/hello" }, environment: environment({ network: "off" }) });
		const { summary } = await t.runtime.execute("dev_environment_get", {}, "c");
		expect(summary).toContain("pnpm install");
		expect(summary).toContain("API_KEY");
		expect(summary).not.toContain(SECRET);
		expect(summary).toMatch(/internet fica desligada/);
		const none = setup({ existing: { repo: "octo/outro" } });
		expect((await none.runtime.execute("dev_environment_get", {}, "c")).summary).toMatch(/Ainda não há ambiente/);
		await expect(none.runtime.execute("dev_environment_get", { repo: "lixo" }, "c")).rejects.toThrow(/repo inválido/);
	});

	it("sem ambiente nada muda: sem política aplicada e tier padrão", async () => {
		const t = setup({ existing: null });
		await t.runtime.execute("dev_session_start", { repo: "octo/hello", tier: "large" }, "c");
		expect(t.egressCalls).toHaveLength(0);
		expect(t.getRow()?.tier).toBe("large");
	});
});

describe("runtime: ambiente automático (zero configuração)", () => {
	const PROBE = ["::ROOT::", "package.json", "pnpm-lock.yaml", "turbo.json", "::FILE:package.json::", JSON.stringify({ packageManager: "pnpm@9.0.0", scripts: { dev: "turbo dev", test: "vitest", lint: "x" } })].join(String.fromCharCode(10));
	const execResult = (cmd: string): Partial<DevExecSnapshot> => (cmd.includes("::ROOT::") ? { stdout: PROBE } : {});

	it("sem ambiente, lê o clone localmente, cria um ambiente auto e roda a instalação detectada", async () => {
		const t = setup({ existing: null, autoEnv: true, execResult });
		const { summary } = await t.runtime.execute("dev_session_start", { repo: "octo/hello" }, "c");
		expect(summary).toMatch(/detectado automaticamente/);
		const env = t.savedEnvs.get("octo/hello")!;
		expect(env).toMatchObject({ installCommand: "pnpm install --frozen-lockfile", startCommand: "pnpm dev", tier: "medium", source: "auto" });
		expect(env.commandAllowlist).toContain("pnpm test");
		const steps = t.events.filter((e) => e.type === "dev_setup_step").map((e) => (e.type === "dev_setup_step" ? e.step : ""));
		expect(steps).toEqual(expect.arrayContaining(["clone", "detect", "install"]));
		expect(t.events.some((e) => e.type === "dev_environment_updated" && e.auto === true)).toBe(true);
		// nenhum token no probe local
		const detect = t.execStarts.find((e) => e.cmd.includes("::ROOT::"))!;
		expect(Object.keys(detect.env ?? {})).toEqual(["DEV_REPO_DIR"]);
		const install = t.execStarts.find((e) => e.env?.DEV_INSTALL_CMD)!;
		expect(install.env?.DEV_INSTALL_CMD).toBe("pnpm install --frozen-lockfile");
	});

	it("projeto não reconhecido: segue sem ambiente e avisa", async () => {
		const t = setup({ existing: null, autoEnv: true, execResult: (cmd) => (cmd.includes("::ROOT::") ? { stdout: "::ROOT::\nREADME.md" } : {}) });
		const { summary } = await t.runtime.execute("dev_session_start", { repo: "octo/hello" }, "c");
		expect(summary).toMatch(/Não reconheci/);
		expect(t.savedEnvs.size).toBe(0);
	});

	it("ambiente salvo pelo usuário não é recriado nem lido", async () => {
		const t = setup({ existing: null, autoEnv: true, environment: environment({ installCommand: null }), execResult });
		await t.runtime.execute("dev_session_start", { repo: "octo/hello" }, "c");
		expect(t.savedEnvs.size).toBe(0);
		expect(t.execStarts.some((e) => e.cmd.includes("::ROOT::"))).toBe(false);
	});

	it("dev_environment_update grava comandos, respeita campos editados e o teto, e nunca mexe em rede/segredos", async () => {
		const t = setup({ existing: { repo: "octo/hello" }, autoEnv: true, config: { maxTier: "medium" } });
		t.savedEnvs.set("octo/hello", { ...environment({ tier: "small", network: "allowlist" }), secrets: {}, source: "auto", userEditedFields: ["installCommand"], commandAllowlist: ["git add"] });
		const first = await t.runtime.execute("dev_environment_update", { installCommand: "npm ci", startCommand: "npm run dev", commandAllowlistAdd: ["npm test", "sudo rm -rf /"], network: "full", secrets: { A: "b" }, tier: "large" }, "c");
		expect(first.summary).toContain("startCommand");
		expect(first.summary).toMatch(/installCommand \(editado pelo usuário\)/);
		expect(first.summary).toMatch(/teto do servidor/);
		expect(first.summary).toMatch(/Recursos aumentados para Médio/);
		const saved = t.savedEnvs.get("octo/hello")!;
		expect(saved.installCommand).toBe("pnpm install");
		expect(saved.startCommand).toBe("npm run dev");
		expect(saved.commandAllowlist).toEqual(["git add", "npm test"]);
		expect(saved.tier).toBe("medium");
		expect(saved.network).toBe("allowlist");
		expect(saved.secrets).toEqual({});
		// o container foi recriado com mais memória e o painel foi avisado
		expect(t.provider.destroy).toHaveBeenCalled();
		expect(t.getRow()?.tier).toBe("medium");
		expect(t.events.some((e) => e.type === "dev_environment_updated" && e.note === "Recursos aumentados para Médio")).toBe(true);
		await expect(t.runtime.execute("dev_environment_update", { network: "full" }, "c")).rejects.toThrow(/Informe ao menos um campo/);
		await expect(t.runtime.execute("dev_environment_update", { tier: "enorme" }, "c")).rejects.toThrow(/tier/);
	});

	it("request_secrets pede só nomes; o resultado nunca traz valores; nomes já definidos não são pedidos de novo", async () => {
		const t = setup({ existing: { repo: "octo/hello" }, autoEnv: true, secretsGate: true });
		t.savedEnvs.set("octo/hello", { ...environment(), secrets: { DB_URL: "valor-super-secreto-xyz" }, source: "auto" });
		const res = await t.runtime.execute("request_secrets", { names: ["DB_URL", "STRIPE_KEY"], reason: "o app abre o banco" }, "c");
		expect(t.gateCalls).toHaveLength(1);
		expect(t.gateCalls[0]).toMatchObject({ environmentId: "e1", names: ["STRIPE_KEY"], title: "Este projeto precisa de: STRIPE_KEY" });
		expect(res.confirmEvent?.type).toBe("confirm");
		expect(JSON.stringify(res)).not.toContain("valor-super-secreto-xyz");
		expect(JSON.stringify(t.gateCalls)).not.toContain("valor-super-secreto-xyz");
		const already = await t.runtime.execute("request_secrets", { names: ["DB_URL"], reason: "x" }, "c");
		expect(already.confirmEvent).toBeUndefined();
		expect(t.gateCalls).toHaveLength(1);
		await expect(t.runtime.execute("request_secrets", { names: ["GH_TOKEN"], reason: "x" }, "c")).rejects.toThrow(/reservado/);
		const noGate = setup({ existing: { repo: "octo/hello" }, autoEnv: true });
		await expect(noGate.runtime.execute("request_secrets", { names: ["A_B"], reason: "x" }, "c")).rejects.toThrow(/não está disponível/);
	});

	it("comando morto por memória (137) e variável ausente ganham dicas para o agente", async () => {
		const oom = setup({ existing: { repo: "octo/hello", tier: "small" }, polls: [snapshot({ exitCode: 137, stderr: "Killed" })] });
		const a = await oom.runtime.execute("shell", { cmd: "pnpm build" }, "c");
		expect(a.summary).toMatch(/falta de memória/);
		expect(a.summary).toContain("dev_environment_update");
		const miss = setup({ existing: { repo: "octo/hello" }, polls: [snapshot({ exitCode: 1, stderr: "Error: Missing environment variable DATABASE_URL" })] });
		const b = await miss.runtime.execute("shell", { cmd: "pnpm test" }, "c");
		expect(b.summary).toMatch(/request_secrets/);
		expect(b.summary).toContain("DATABASE_URL");
		const fine = setup({ existing: { repo: "octo/hello" } });
		expect((await fine.runtime.execute("shell", { cmd: "ls" }, "c")).summary).not.toMatch(/request_secrets|memória/);
	});
});

describe("runtime: diagnósticos depois da edição", () => {
	const TSC_OUTPUT = [
		"src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
		"src/a.ts(9,1): warning TS6133: 'x' is declared but never used.",
	].join(String.fromCharCode(10));

	function diagSetup(options: { diagnostics?: boolean | { settleMs?: number; debounceMs?: number }; typecheckOutput?: string; detect?: string } = {}) {
		const detect = options.detect ?? ["PKG=/workspace/pkg", "CMD=pnpm run typecheck"].join(String.fromCharCode(10));
		return setup({
			diagnostics: options.diagnostics ?? { settleMs: 5, debounceMs: 20 },
			execResult: (cmd) => (cmd.includes("DEV_DIAG_FILE") ? { stdout: detect, nextOut: detect.length } : cmd === "pnpm run typecheck" ? { stdout: options.typecheckOutput ?? TSC_OUTPUT, exitCode: 2 } : {}),
		});
	}

	it("edita, roda o typecheck do pacote em segundo plano e injeta o bloco no PRÓXIMO resultado, sem bloquear a edição", async () => {
		const t = diagSetup();
		const edit = await t.runtime.execute("edit_file", { path: "pkg/src/a.ts", old: "a", new: "b" }, "c1");
		expect(edit.summary).toContain("Editado");
		expect(edit.summary).not.toContain("Diagnósticos");
		await vi.waitFor(() => expect(t.execStarts.some((s) => s.cmd === "pnpm run typecheck")).toBe(true), { timeout: 3_000 });
		expect(t.execStarts.find((s) => s.cmd === "pnpm run typecheck")).toMatchObject({ cwd: "/workspace/pkg" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		const next = await t.runtime.execute("list_files", {}, "c2");
		expect(next.summary).toContain("Diagnósticos após a edição");
		expect(next.summary).toContain("pkg/src/a.ts:3:7 error TS2322");
		expect(next.summary.indexOf("error TS2322")).toBeLessThan(next.summary.indexOf("warning TS6133"));
		// Dedupe: o mesmo diagnóstico não volta; sem novidade nada é injetado.
		const after = await t.runtime.execute("list_files", {}, "c3");
		expect(after.summary).not.toContain("Diagnósticos");
	});

	it("sem comando de typecheck detectado não roda nada e não injeta nada", async () => {
		const t = diagSetup({ detect: "" });
		await t.runtime.execute("edit_file", { path: "pkg/src/a.ts", old: "a", new: "b" }, "c1");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(t.execStarts.map((s) => s.cmd)).toHaveLength(1);
		const next = await t.runtime.execute("list_files", {}, "c2");
		expect(next.summary).not.toContain("Diagnósticos");
	});

	it("typecheck limpo não injeta nada", async () => {
		const t = diagSetup({ typecheckOutput: "" });
		await t.runtime.execute("write_file", { path: "pkg/src/b.ts", content: "export {}" }, "c1");
		await vi.waitFor(() => expect(t.execStarts.some((s) => s.cmd === "pnpm run typecheck")).toBe(true), { timeout: 3_000 });
		await new Promise((resolve) => setTimeout(resolve, 50));
		const next = await t.runtime.execute("list_files", {}, "c2");
		expect(next.summary).not.toContain("Diagnósticos");
	});

	it("arquivos que não são TS/JS não disparam nada; desligado não dispara nada", async () => {
		const md = diagSetup();
		await md.runtime.execute("write_file", { path: "pkg/README.md", content: "# oi" }, "c1");
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(md.execStarts).toHaveLength(0);
		const off = diagSetup({ diagnostics: false });
		await off.runtime.execute("edit_file", { path: "pkg/src/a.ts", old: "a", new: "b" }, "c1");
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(off.execStarts).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Cache de dependências do ambiente (volume /envcache)
// ---------------------------------------------------------------------------

describe("runtime: cache de dependências do ambiente", () => {
	const keyFor = (patch: { lock?: string; env?: Record<string, string>; install?: string } = {}) =>
		computeEnvCacheKey({ userId: "u1", repo: "octo/hello", installCommand: patch.install ?? "pnpm install", lockHash: patch.lock ?? "lock-a", runtime: "2 v22.0.0 x86_64", env: patch.env ?? { API_KEY: SECRET } });
	const probeOutput = (saved: ReturnType<typeof keyFor> | null) =>
		[`writable=1`, `runtime=2 v22.0.0 x86_64`, `lock=lock-a`, `saved=${saved ? JSON.stringify({ key: saved.key, parts: saved.parts, savedAt: 1 }) : ""}`].join(String.fromCharCode(10));
	const run = async (saved: ReturnType<typeof keyFor> | null, extra: Partial<DevEnvironmentRuntime> = {}) => {
		const t = setup({
			existing: null,
			environment: environment(extra),
			config: { cacheEnabled: true },
			execResult: (cmd) => (cmd === CACHE_PROBE_SCRIPT ? { stdout: probeOutput(saved) } : {}),
		});
		const { summary } = await t.runtime.execute("dev_session_start", { repo: "octo/hello" }, "c");
		const scripts = t.execStarts.map((e) => e.cmd);
		const install = t.events.filter((e) => e.type === "dev_setup_step" && e.step === "install") as Array<Extract<DevSessionEvent, { type: "dev_setup_step" }>>;
		return { t, summary, scripts, install, last: install.at(-1)! };
	};

	it("sem cache salvo (miss): instala e guarda as dependências, sem restaurar", async () => {
		const r = await run(null);
		expect(r.last.cache).toBe("miss");
		expect(r.scripts).toContain(CACHE_SAVE_SCRIPT);
		expect(r.scripts).not.toContain(CACHE_RESTORE_SCRIPT);
		const save = r.t.execStarts.find((e) => e.cmd === CACHE_SAVE_SCRIPT)!;
		expect(JSON.parse(save.env!.DEV_CACHE_META!).key).toBe(keyFor().key);
	});

	it("mesma chave (hit): restaura, roda a instalação como manutenção e não salva de novo", async () => {
		const r = await run(keyFor());
		expect(r.last.cache).toBe("hit");
		expect(r.scripts.indexOf(CACHE_RESTORE_SCRIPT)).toBeGreaterThan(-1);
		expect(r.scripts.indexOf(CACHE_RESTORE_SCRIPT)).toBeLessThan(r.scripts.indexOf(INSTALL_SCRIPT));
		expect(r.scripts).not.toContain(CACHE_SAVE_SCRIPT);
		expect(r.summary).toContain("restauradas do cache");
	});

	it("lockfile mudou (stale): restaura, instala por cima e salva a chave nova", async () => {
		const r = await run(keyFor({ lock: "lock-antigo" }));
		expect(r.last.cache).toBe("stale");
		expect(r.scripts).toContain(CACHE_RESTORE_SCRIPT);
		expect(r.scripts).toContain(CACHE_SAVE_SCRIPT);
	});

	it("segredos ou comando mudaram (rebuild): apaga o cache, não restaura e salva de novo", async () => {
		const secrets = await run(keyFor({ env: { API_KEY: "outro-valor" } }));
		expect(secrets.last.cache).toBe("rebuild");
		expect(secrets.scripts).toContain(CACHE_WIPE_SCRIPT);
		expect(secrets.scripts).not.toContain(CACHE_RESTORE_SCRIPT);
		expect(secrets.scripts).toContain(CACHE_SAVE_SCRIPT);
		const command = await run(keyFor({ install: "npm ci" }));
		expect(command.last.cache).toBe("rebuild");
	});

	it("nenhum valor de segredo vai para o script, os metadados ou os eventos do cache", async () => {
		const r = await run(null);
		const save = r.t.execStarts.find((e) => e.cmd === CACHE_SAVE_SCRIPT)!;
		expect(save.env!.DEV_CACHE_META).not.toContain(SECRET);
		expect(JSON.stringify(r.t.events)).not.toContain(SECRET);
	});

	it("volume não montado (writable=0) ou cache desligado: instala normalmente, sem estado de cache", async () => {
		const t = setup({ existing: null, environment: environment(), config: { cacheEnabled: true }, execResult: (cmd) => (cmd === CACHE_PROBE_SCRIPT ? { stdout: "writable=0" } : {}) });
		await t.runtime.execute("dev_session_start", { repo: "octo/hello" }, "c");
		expect(t.events.some((e) => e.type === "dev_setup_step" && e.step === "install" && e.cache)).toBe(false);
		expect(t.execStarts.map((e) => e.cmd)).not.toContain(CACHE_SAVE_SCRIPT);
		const off = setup({ existing: null, environment: environment() });
		await off.runtime.execute("dev_session_start", { repo: "octo/hello" }, "c");
		expect(off.execStarts.map((e) => e.cmd)).not.toContain(CACHE_PROBE_SCRIPT);
	});

	it("pede o volume de cache do repositório ao provedor", async () => {
		const r = await run(null);
		expect(r.t.provider.ensureRunning).toHaveBeenCalledWith(expect.objectContaining({ envCacheRepo: "octo/hello" }));
	});
});
