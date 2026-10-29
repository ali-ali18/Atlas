import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult, LlmMessage } from "@workspace/llm";
import type { DevClient, DevExecSnapshot } from "@workspace/sandbox";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";

vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	getDevApprovalDefault: vi.fn(async () => "auto"),
	getDevVerifierEnabled: vi.fn(async () => false),
	findExecutedConfirmCall: vi.fn(async () => null),
}));

type DevSessionParam = NonNullable<Parameters<typeof runComputerUse>[0]["devSession"]>;

const EDIT_MISS = "old não foi encontrado no arquivo. Leia o trecho atual (read_file) e copie o texto exatamente, com a indentação.";

function call(id: string, name: string, args: Record<string, unknown>) {
	return { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}

function step(...calls: Array<ReturnType<typeof call>>): CompleteChatWithToolsResult {
	return { model: "test-model", message: { role: "assistant", content: null, tool_calls: calls } };
}

function text(content: string): CompleteChatWithToolsResult {
	return { model: "test-model", message: { role: "assistant", content } };
}

function exited(exitCode: number, stdout = ""): DevExecSnapshot {
	return {
		id: "0123456789ab",
		status: "exited",
		running: false,
		exitCode,
		signal: null,
		timedOut: false,
		stdout,
		stderr: "",
		nextOut: stdout.length,
		nextErr: 0,
		truncated: false,
		omittedBytes: 0,
		durationMs: 1000,
		cwd: "/workspace",
	};
}

type Harness = {
	/** `edit_file` falha enquanto devolver `true` (recebe o número da chamada, a partir de 1). */
	editFails?: (n: number, input: { path: string; old: string }) => boolean;
	/** Resultado do `shell` pelo comando. */
	exec?: (cmd: string) => DevExecSnapshot;
	active?: boolean;
	/** `write_file` e `list_files` explodem (falha comum, não de argumento). */
	breakOthers?: boolean;
	origin?: "chat" | "webhook";
	maxSteps?: number;
	budget?: Record<string, unknown>;
};

async function run(queue: CompleteChatWithToolsResult[], h: Harness = {}) {
	const requests: LlmMessage[][] = [];
	const toolResults: Array<{ name: string; ok: boolean; summary: string }> = [];
	const execStarts: string[] = [];
	let editCalls = 0;
	let probes = 0;
	const client = {
		execStart: vi.fn(async (input: { cmd: string }) => {
			execStarts.push(input.cmd);
			return { id: "0123456789ab" };
		}),
		execPoll: vi.fn(async () => exited(0)),
		readFile: vi.fn(async () => ({ path: "/workspace/a.ts", kind: "text", size: 5, content: "uno", totalLines: 1, nextOffset: null, truncated: false })),
		writeFile: vi.fn(async (input: { path: string; content: string }) => ({ path: `/workspace/${input.path}`, created: false, bytes: input.content.length, diff: "+a", added: 1, removed: 0 })),
		patchFile: vi.fn(async (input: { path: string; old: string }) => {
			editCalls += 1;
			if (h.editFails?.(editCalls, input)) throw new Error(EDIT_MISS);
			return { path: `/workspace/${input.path}`, diff: "-a\n+b", added: 1, removed: 1 };
		}),
		list: vi.fn(async () => ({ path: "/workspace", entries: [], total: 0, truncated: false })),
		grep: vi.fn(async () => ({ matches: "", count: 0, totalFound: 0, truncated: false })),
		health: vi.fn(async () => ({ ok: true, runningJobs: 0 })),
		setEgress: vi.fn(async (policy: unknown) => policy),
	};
	if (h.breakOthers) {
		client.writeFile = vi.fn(async () => {
			throw new Error("disk quota exceeded");
		}) as never;
		client.list = vi.fn(async () => {
			throw new Error("disk quota exceeded");
		}) as never;
	}
	if (h.exec) client.execPoll = vi.fn(async () => h.exec!(execStarts[execStarts.length - 1] ?? ""));
	const devSession = {
		config: { enabled: true },
		store: {
			findForConversation: async () => (h.active === false ? null : { id: "s1", userId: "u1", conversationId: "c1", repo: null, branch: null, baseBranch: null, status: "RUNNING", tier: "small", containerId: "cid", todos: [] }),
			update: async () => undefined,
		},
		provider: { ensureRunning: async () => ({ status: "running", endpoint: { baseUrl: "http://x", token: "t" }, containerId: "cid", resumed: false }) },
		getGithubToken: async () => ({ error: "sem github" }),
		makeClient: () => client as unknown as DevClient,
	} as unknown as DevSessionParam;
	const result = await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		sandboxEnabled: false,
		model: "test-model",
		apiKey: "test",
		runId: "run-code-loop",
		userId: "u1",
		conversationId: "c1",
		origin: h.origin ?? "chat",
		messages: [{ role: "user", content: "corrige o bug em a.ts" }],
		maxSteps: h.maxSteps ?? 40,
		...(h.budget ? { budget: h.budget } : {}),
		devSession,
		onEvent: (event) => {
			if (event.type === "tool_result") toolResults.push(event as never);
		},
		streamChat: async (params) => {
			requests.push(params.messages.map((m) => ({ ...m })));
			// Avaliação brando do limite de passos (probe interno): responde que concluiu.
			const last = params.messages[params.messages.length - 1];
			if (last?.role === "system" && String(last.content).startsWith("AVALIAÇÃO DE PROGRESSO")) {
				probes += 1;
				return text(JSON.stringify({ concluded: true, summary: "Concluído pelo probe.", continueReason: "" }));
			}
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
	} as Parameters<typeof runComputerUse>[0]);
	return { result, requests, toolResults, execStarts, client, probes: () => probes };
}

const edit = (id: string, path = "a.ts", old = "x") => call(id, "edit_file", { path, old, new: "y" });

describe("edição que não casa não bloqueia a tool no run", () => {
	it("6 edições seguidas que falham: a 7ª ainda executa (edit_file nunca é bloqueada)", async () => {
		const { result, toolResults, client } = await run(
			[
				...Array.from({ length: 6 }, (_, i) => step(edit(`e${i}`, "a.ts", `anchor ${i}`))),
				step(edit("e6", "a.ts", "anchor certo")),
				text("Corrigido."),
			],
			{ editFails: (n) => n < 7 },
		);
		expect(result.text).toBe("Corrigido.");
		expect(client.patchFile).toHaveBeenCalledTimes(7);
		expect(toolResults.some((r) => /indisponível neste run/.test(r.summary))).toBe(false);
		expect(toolResults[6]).toMatchObject({ name: "edit_file", ok: true });
	});

	it("a partir da 3ª falha no mesmo arquivo a mensagem de erro traz a escalada", async () => {
		const { toolResults } = await run(
			[...Array.from({ length: 4 }, (_, i) => step(edit(`e${i}`, "a.ts", `anchor ${i}`))), text("Não consegui.")],
			{ editFails: () => true },
		);
		const hint = /stop varying `old`.*read_file.*longer unique anchor.*write_file/i;
		expect(toolResults[0]?.summary).not.toMatch(hint);
		expect(toolResults[1]?.summary).not.toMatch(hint);
		expect(toolResults[2]?.summary).toMatch(hint);
		expect(toolResults[3]?.summary).toMatch(hint);
	});

	it("falhas em arquivos diferentes não escalam", async () => {
		const { toolResults } = await run(
			[...Array.from({ length: 4 }, (_, i) => step(edit(`e${i}`, `f${i}.ts`))), text("ok")],
			{ editFails: () => true },
		);
		expect(toolResults.every((r) => !/stop varying/i.test(r.summary))).toBe(true);
	});

	it("edit_file e write_file falhando junto de uma terceira tool não derrubam o run pela trava global", async () => {
		const { result } = await run(
			[
				...Array.from({ length: 8 }, (_, i) =>
					step(edit(`e${i}`, "a.ts", `anchor ${i}`), call(`w${i}`, "write_file", { path: "b.ts", content: "x" }), call(`l${i}`, "list_files", { path: `d${i}` })),
				),
				text("Segui sem conseguir editar."),
			],
			{ editFails: () => true, breakOthers: true },
		);
		expect(result.text).toBe("Segui sem conseguir editar.");
	});
});

const SOFT = { softMaxSteps: 3, hardMaxSteps: 30, extensionSteps: 10 };
const testShell = (id: string, cmd = "pnpm test") => call(id, "shell", { cmd });

describe("limite brando não encerra run de código com trabalho sem verificar", () => {
	it("edições sem verificação: o limite estende em vez de concluir", async () => {
		const { result, probes, execStarts } = await run(
			[step(edit("e1")), step(edit("e2", "b.ts")), step(edit("e3", "c.ts")), step(testShell("t1")), text("Tudo verde.")],
			{ budget: SOFT, exec: () => exited(0, "ok") },
		);
		expect(probes()).toBe(0);
		expect(execStarts).toEqual(["pnpm test"]);
		expect(result.text).toBe("Tudo verde.");
	});

	it("depois de uma verificação que passou o limite avalia como antes (pode concluir)", async () => {
		const { result, probes } = await run(
			[step(edit("e1")), step(testShell("t1")), step(call("r1", "read_file", { path: "a.ts" })), text("não deve chegar aqui")],
			{ budget: SOFT, exec: () => exited(0, "ok") },
		);
		expect(probes()).toBe(1);
		expect(result.text).toBe("Concluído pelo probe.");
	});

	it("verificação que falhou (exit 1) não conta: continua estendendo", async () => {
		const { probes } = await run(
			[step(edit("e1")), step(testShell("t1")), step(call("r1", "read_file", { path: "a.ts" })), text("Corrigi o que faltava.")],
			{ budget: SOFT, exec: () => exited(1, "1 failed") },
		);
		expect(probes()).toBe(0);
	});

	it("sem edição nem job (só leitura) o limite avalia como antes", async () => {
		const { result, probes } = await run(
			[step(call("r1", "read_file", { path: "a.ts" })), step(call("r2", "read_file", { path: "b.ts" })), step(call("r3", "grep", { pattern: "x" })), text("não deve chegar aqui")],
			{ budget: SOFT },
		);
		expect(probes()).toBe(1);
		expect(result.text).toBe("Concluído pelo probe.");
	});

	it("o teto duro continua valendo: edição sem verificar não passa de hardMaxSteps", async () => {
		const queue = Array.from({ length: 12 }, (_, i) => step(edit(`e${i}`, `f${i}.ts`)));
		const error = await run(queue, { budget: { softMaxSteps: 3, hardMaxSteps: 6, extensionSteps: 10 } }).catch((e: unknown) => e);
		expect(String((error as Error).message ?? error)).toMatch(/limite de 6 passos/);
	});
});
