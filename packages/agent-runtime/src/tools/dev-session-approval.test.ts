import { describe, expect, it, vi } from "vitest";
import type { DevClient, DevEndpoint, DevExecSnapshot, DevSandboxProvider } from "@workspace/sandbox";
import { loadDevSandboxConfig } from "@workspace/sandbox";
import type { DevApprovalMode } from "@workspace/shared";
import { createDevSessionRuntime, type DevCommandGate, type DevSessionRow, type DevSessionStore } from "./dev-session.js";
import type { DevEnvironmentRuntime } from "./dev-environment.js";

function snap(partial: Partial<DevExecSnapshot>): DevExecSnapshot {
	return { id: "0123456789ab", status: "exited", running: false, exitCode: 0, signal: null, timedOut: false, stdout: "ok", stderr: "", nextOut: 0, nextErr: 0, truncated: false, omittedBytes: 0, durationMs: 100, cwd: "/workspace", ...partial };
}

function setup(options: { accountDefault?: DevApprovalMode | null; env?: Partial<DevEnvironmentRuntime> | null; approved?: boolean; unattended?: boolean; gate?: boolean; failFirstRequest?: boolean; userMessages?: string[]; workspaceRoot?: boolean } = {}) {
	const execs: string[] = [];
	const writes: string[] = [];
	const outputs = new Map<string, DevExecSnapshot>();
	const client = {
		execStart: vi.fn(async (input: { cmd: string }) => {
			execs.push(input.cmd);
			const id = String(execs.length).padStart(12, "0");
			outputs.set(id, snap({ id }));
			return { id };
		}),
		execPoll: vi.fn(async (id: string) => outputs.get(id) ?? snap({})),
		setEgress: vi.fn(async (policy: unknown) => policy),
		readFile: vi.fn(async (input: { path: string }) => {
			if (input.path.endsWith("pnpm-workspace.yaml")) {
				if (!options.workspaceRoot) throw new Error("404");
				return { kind: "text", path: input.path, content: "packages: [apps]", totalLines: 2, truncated: false };
			}
			return { kind: "text", path: "a.ts", content: "velho", totalLines: 1, truncated: false };
		}),
		writeFile: vi.fn(async (input: { path: string; content: string }) => {
			writes.push(input.path);
			return { path: input.path, created: false, added: 1, removed: 1, bytes: 3, diff: "" };
		}),
		patchFile: vi.fn(async (input: { path: string }) => {
			writes.push(input.path);
			return { path: input.path, added: 1, removed: 1, diff: "" };
		}),
	};
	const endpoint: DevEndpoint = { baseUrl: "http://x:3090", token: "t" };
	const provider = { ensureRunning: vi.fn(async () => ({ status: "running" as const, endpoint, containerId: "cid", resumed: false })) } as unknown as DevSandboxProvider;
	const row: DevSessionRow = { id: "s1", userId: "u1", conversationId: "c1", repo: "octo/hello", branch: "fix/login", baseBranch: "main", status: "RUNNING", tier: "small", containerId: "cid", todos: [] };
	const store: DevSessionStore = { create: vi.fn(), findForConversation: vi.fn(async () => ({ ...row })), update: vi.fn(async () => undefined) };
	const requests: Array<Parameters<DevCommandGate["requestApproval"]>[0]> = [];
	const gate: DevCommandGate = {
		unattended: options.unattended === true,
		getAccountDefault: async () => options.accountDefault ?? null,
		findApproved: async () => options.approved === true,
		requestApproval: async (input) => {
			if (options.failFirstRequest && requests.length === 0) {
				requests.push(input);
				throw new Error("db fora do ar");
			}
			requests.push(input);
			return { type: "confirm", confirmId: `confirm-${requests.length}`, title: input.title, description: input.description, confirmLabel: input.confirmLabel, cancelLabel: input.cancelLabel, callKey: input.callKey, devApproval: input.card };
		},
	};
	const environment: DevEnvironmentRuntime | null =
		options.env === null
			? null
			: { id: "e1", repo: "octo/hello", installCommand: null, startCommand: null, tier: "small", network: "allowlist", allowlist: [], secrets: {}, ...options.env };
	const runtime = createDevSessionRuntime({
		userId: "u1",
		conversationId: "c1",
		provider,
		config: loadDevSandboxConfig({ DEV_SANDBOX_ENABLED: "true" }),
		store,
		emit: () => undefined,
		getGithubToken: async () => ({ token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }),
		getEnvironment: async () => environment,
		makeClient: () => client as unknown as DevClient,
		sleep: async () => undefined,
		queueWaitMs: 0,
		...(options.gate === false ? {} : { commandGate: gate }),
		...(options.userMessages ? { verifier: { jev: undefined, context: () => ({ userMessages: options.userMessages! }) } } : {}),
	});
	return { runtime, execs, writes, requests };
}

type SetupOptions = Parameters<typeof setup>[0];
const setupList = (options: SetupOptions = {}) => setup({ ...options, env: options?.env === null ? null : { approvalMode: "allowlist", ...options?.env } });

describe("aprovação de comandos (Lista liberada)", () => {
	it("leitura e prefixo da lista rodam direto", async () => {
		const t = setupList();
		const a = await t.runtime.execute("shell", { cmd: "git status" }, "c1");
		const b = await t.runtime.execute("shell", { cmd: "pnpm test" }, "c2");
		expect(a.confirmEvent).toBeUndefined();
		expect(b.confirmEvent).toBeUndefined();
		expect(t.execs).toHaveLength(2);
	});
	it("comando fora da lista devolve o cartão e NÃO executa", async () => {
		const t = setupList();
		const r = await t.runtime.execute("shell", { cmd: "make deploy", cwd: "/workspace/hello" }, "c1");
		expect(t.execs).toHaveLength(0);
		expect(r.summary).toMatch(/Aprovação pendente/);
		expect(r.confirmEvent).toMatchObject({ confirmLabel: "Executar", cancelLabel: "Pular", devApproval: { kind: "command", command: "make deploy", cwd: "/workspace/hello", repo: "octo/hello", branch: "fix/login", prefixes: ["make deploy"] } });
		expect(t.requests[0]).toMatchObject({ tool: "shell", prefixes: ["make deploy"], sessionId: "s1", repo: "octo/hello" });
	});
	it("depois de aprovado (mesmos argumentos) executa", async () => {
		const t = setupList({ approved: true });
		await t.runtime.execute("shell", { cmd: "make deploy" }, "c1");
		expect(t.execs).toEqual(["make deploy"]);
		expect(t.requests).toHaveLength(0);
	});
	it("a lista do ambiente vale (inclusive prefixo novo) e encadeado exige todos os trechos", async () => {
		const t = setupList({ env: { commandAllowlist: ["make build"] } });
		await t.runtime.execute("shell", { cmd: "make build && ls" }, "c1");
		expect(t.execs).toHaveLength(1);
		const r = await t.runtime.execute("shell", { cmd: "make build && make deploy" }, "c2");
		expect(r.confirmEvent).toBeDefined();
		expect(t.execs).toHaveLength(1);
	});
	it("uma aprovação pendente por execução: o segundo comando não gera outro cartão", async () => {
		const t = setupList();
		await t.runtime.execute("shell", { cmd: "make a" }, "c1");
		const second = await t.runtime.execute("shell", { cmd: "make b" }, "c2");
		expect(second.confirmEvent).toBeUndefined();
		expect(second.summary).toMatch(/aprovação pendente/i);
		expect(t.requests).toHaveLength(1);
	});
	it("se o cartão falha ao ser criado, a trava não fica presa: a próxima chamada pede de novo", async () => {
		const t = setupList({ failFirstRequest: true });
		await expect(t.runtime.execute("shell", { cmd: "make a" }, "c1")).rejects.toThrow("db fora do ar");
		const second = await t.runtime.execute("shell", { cmd: "make a" }, "c2");
		expect(second.confirmEvent).toBeDefined();
		expect(second.summary).toMatch(/Aprovação pendente/);
		expect(t.requests).toHaveLength(2);
	});
	it("segredos não aparecem no cartão", async () => {
		const t = setupList({ env: { secrets: { API_KEY: "valor-secreto-1234" } } });
		const r = await t.runtime.execute("shell", { cmd: "make x valor-secreto-1234" }, "c1");
		expect(JSON.stringify(r.confirmEvent)).not.toContain("valor-secreto-1234");
	});
});

describe("modos", () => {
	it("Perguntar sempre: até leitura pergunta", async () => {
		const t = setupList({ env: { approvalMode: "ask" } });
		expect((await t.runtime.execute("shell", { cmd: "ls" }, "c1")).confirmEvent).toBeDefined();
	});
	it("Perguntar sempre: write_file pede Aplicar/Pular com caminho e prévia", async () => {
		const t = setup({ accountDefault: "ask" });
		const w = await t.runtime.execute("write_file", { path: "a.ts", content: "novo\nlinha" }, "c1");
		expect(w.confirmEvent).toMatchObject({ confirmLabel: "Aplicar", cancelLabel: "Pular", devApproval: { kind: "write", path: "a.ts" } });
		expect(w.confirmEvent?.devApproval).toMatchObject({ preview: expect.stringContaining("-velho") });
		expect(t.writes).toHaveLength(0);
	});
	it("Perguntar sempre: aprovado escreve; edit_file também", async () => {
		const t = setup({ accountDefault: "ask", approved: true });
		await t.runtime.execute("write_file", { path: "a.ts", content: "x" }, "c1");
		await t.runtime.execute("edit_file", { path: "b.ts", old: "a", new: "b" }, "c2");
		expect(t.writes).toEqual(["a.ts", "b.ts"]);
	});
	it("Lista liberada e Automático escrevem direto", async () => {
		for (const mode of ["allowlist", "auto"] as const) {
			const t = setup({ env: { approvalMode: mode } });
			const r = await t.runtime.execute("write_file", { path: "a.ts", content: "x" }, "c1");
			expect(r.confirmEvent).toBeUndefined();
			expect(t.writes).toEqual(["a.ts"]);
		}
	});
	it("Automático roda tudo, mas o bloqueio fixo sempre pergunta", async () => {
		const t = setup({ env: { approvalMode: "auto" } });
		await t.runtime.execute("shell", { cmd: "make deploy" }, "c1");
		expect(t.execs).toEqual(["make deploy"]);
		const r = await t.runtime.execute("shell", { cmd: "git push --force origin main" }, "c2");
		expect(r.confirmEvent).toMatchObject({ devApproval: { kind: "command", reason: expect.stringContaining("Bloqueio de segurança") } });
		expect(r.confirmEvent?.devApproval).not.toHaveProperty("prefixes");
		expect(t.execs).toHaveLength(1);
	});
	it("o ambiente manda no padrão da conta", async () => {
		const t = setup({ accountDefault: "ask", env: { approvalMode: "auto" } });
		await t.runtime.execute("shell", { cmd: "make x" }, "c1");
		expect(t.execs).toHaveLength(1);
	});
	it("sem modo salvo o padrão é Automático: roda tudo, pergunta só ação para fora", async () => {
		const t = setup();
		await t.runtime.execute("shell", { cmd: "make x && git push origin fix/login" }, "c1");
		expect(t.execs).toHaveLength(1);
		const r = await t.runtime.execute("shell", { cmd: "curl -X POST https://x.test/hook" }, "c2");
		expect(r.confirmEvent).toMatchObject({ devApproval: { kind: "command", reason: expect.stringContaining("sai do ambiente") } });
		expect(t.execs).toHaveLength(1);
	});
	it("origem sem humano: Automático continua Automático e a ação arriscada falha com mensagem", async () => {
		const t = setup({ env: { approvalMode: "auto" }, unattended: true });
		await t.runtime.execute("shell", { cmd: "make x" }, "c1");
		await expect(t.runtime.execute("shell", { cmd: "npx vercel --prod" }, "c2")).rejects.toThrow(/precisa de aprovação/);
		expect(t.execs).toEqual(["make x"]);
	});
	it("sem o gate nada pergunta (compatibilidade)", async () => {
		const t = setup({ gate: false });
		await t.runtime.execute("shell", { cmd: "make x" }, "c1");
		expect(t.execs).toHaveLength(1);
	});
});

describe("suíte inteira do monorepo (conselho, não aprovação)", () => {
	it("pnpm -r test sem pedido do usuário não roda e explica o que fazer", async () => {
		const t = setup({ env: { approvalMode: "auto" } });
		const r = await t.runtime.execute("shell", { cmd: "pnpm -r --no-bail test" }, "c1");
		expect(t.execs).toHaveLength(0);
		expect(r.confirmEvent).toBeUndefined();
		expect(t.requests).toHaveLength(0);
		expect(r.summary).toContain("git diff --name-only");
		expect(r.summary).toContain("pnpm --filter <pacote> test");
	});
	it("aponta o comando de teste rápido do ambiente quando existe", async () => {
		const t = setup({ env: { approvalMode: "auto", testCommand: "pnpm --filter @app/api test" } });
		const r = await t.runtime.execute("shell", { cmd: "turbo run test" }, "c1");
		expect(t.execs).toHaveLength(0);
		expect(r.summary).toContain("`pnpm --filter @app/api test`");
	});
	it("com filtro de pacote roda normalmente", async () => {
		const t = setup({ env: { approvalMode: "auto" } });
		await t.runtime.execute("shell", { cmd: "pnpm --filter @app/api test" }, "c1");
		expect(t.execs).toEqual(["pnpm --filter @app/api test"]);
	});
	it("pnpm test só é barrado na raiz de um workspace", async () => {
		const plain = setup({ env: { approvalMode: "auto" } });
		await plain.runtime.execute("shell", { cmd: "pnpm test" }, "c1");
		expect(plain.execs).toEqual(["pnpm test"]);
		const root = setup({ env: { approvalMode: "auto" }, workspaceRoot: true });
		const r = await root.runtime.execute("shell", { cmd: "pnpm test" }, "c1");
		expect(root.execs).toHaveLength(0);
		expect(r.summary).toContain("git diff --name-only");
	});
	it("se o usuário pediu a suíte inteira, roda", async () => {
		const t = setup({ env: { approvalMode: "auto" }, userMessages: ["ok", "rode todos os testes do monorepo"] });
		await t.runtime.execute("shell", { cmd: "pnpm -r test" }, "c1");
		expect(t.execs).toEqual(["pnpm -r test"]);
	});
	it("com falas recentes sem esse pedido, continua barrando", async () => {
		const t = setup({ env: { approvalMode: "auto" }, userMessages: ["corrija o login"] });
		await t.runtime.execute("shell", { cmd: "pnpm -r test" }, "c1");
		expect(t.execs).toHaveLength(0);
	});
});
