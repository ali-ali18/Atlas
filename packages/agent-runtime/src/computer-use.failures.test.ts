import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult, LlmMessage } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { buildMcpToolset } from "./mcp/registry.js";
import type { McpRuntime } from "./mcp/runtime.js";
import { ARGUMENT_ERROR_HINT } from "./tool-failure.js";
import { runComputerUse } from "./computer-use.js";

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		searchMemoryEntries: async () => [],
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		listRoutines: vi.fn(async () => []),
	};
});

vi.mock("./github/hook-sync.js", () => ({
	ensureGithubRepoHook: vi.fn(async () => ({ ok: true })),
}));

function step(
	calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
): CompleteChatWithToolsResult {
	return {
		model: "test-model",
		message: {
			role: "assistant",
			content: null,
			tool_calls: calls.map((call) => ({
				id: call.id,
				type: "function" as const,
				function: { name: call.name, arguments: JSON.stringify(call.args) },
			})),
		},
	};
}

function text(content: string): CompleteChatWithToolsResult {
	return { model: "test-model", message: { role: "assistant", content } };
}

const github = {
	id: "conn-gh",
	slug: "github",
	name: "GitHub",
	disabledTools: [],
	confirmWrites: true,
	tools: [
		{
			name: "get_file_contents",
			description: "Lê arquivo ou pasta",
			inputSchema: { type: "object", properties: { path: { type: "string" } } },
			annotations: { readOnlyHint: true },
		},
	],
};

const NAME = "mcp__github__get_file_contents";
const PATH_ERROR = "path does not point to a file or directory";

async function run(
	mcpCall: McpRuntime["call"],
	queue: CompleteChatWithToolsResult[],
) {
	const toolResults: Array<{ name: string; ok: boolean; summary: string }> = [];
	const result = await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => {
			throw new Error("nao deve criar sessao");
		},
		sandboxEnabled: false,
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: "revise o repo" }],
		runId: "run-loja-exemplo",
		maxSteps: 12,
		mcp: { toolset: buildMcpToolset([github]), call: mcpCall },
		onEvent: (event) => {
			if (event.type === "tool_result") toolResults.push(event);
		},
		streamChat: async () => {
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
	});
	return { result, toolResults };
}

describe("F4 - caso loja-exemplo: falhas em lote e erro de argumento", () => {
	it("4 get_file_contents paralelos com 'path does not point' nao derrubam o run", async () => {
		const call = vi.fn(async (_name: string, args: Record<string, unknown>) =>
			args.path === "docs"
				? { ok: true, text: "README.md\nCHANGELOG.md", truncated: false }
				: { ok: false, text: PATH_ERROR, truncated: false },
		);
		const { result, toolResults } = await run(call, [
			step(
				["a.md", "b.md", "c.md", "d.md"].map((path, i) => ({
					id: `p${i}`,
					name: NAME,
					args: { path },
				})),
			),
			step([{ id: "l1", name: NAME, args: { path: "docs" } }]),
			text("Pronto, revisei."),
		]);
		expect(result.text).toContain("Pronto");
		expect(call).toHaveBeenCalledTimes(5);
		expect(toolResults.slice(0, 4).every((r) => !r.ok)).toBe(true);
		// O modelo recebe dica acionavel no tool_result.
		expect(toolResults[0]?.summary).toContain(ARGUMENT_ERROR_HINT);
		// O passo seguinte executou de verdade (tool nao foi bloqueada).
		expect(toolResults[4]).toMatchObject({ ok: true });
	});

	it("dois erros de argumento seguidos nao abortam nem bloqueiam a tool", async () => {
		const notFound = vi.fn(async () => ({
			ok: false,
			text: "Not Found (404)",
			truncated: false,
		}));
		const { result } = await run(notFound, [
			step([{ id: "1", name: NAME, args: { path: "1" } }]),
			step([{ id: "2", name: NAME, args: { path: "2" } }]),
			text("Conclui com o que consegui."),
		]);
		expect(result.text).toContain("Conclui");
		expect(notFound).toHaveBeenCalledTimes(2);
	});

	it("3 passos seguidos falhando por argumento ainda bloqueiam a tool", async () => {
		const notFound = vi.fn(async () => ({
			ok: false,
			text: "Not Found (404)",
			truncated: false,
		}));
		const { result, toolResults } = await run(notFound, [
			step([{ id: "1", name: NAME, args: { path: "1" } }]),
			step([{ id: "2", name: NAME, args: { path: "2" } }]),
			step([{ id: "3", name: NAME, args: { path: "3" } }]),
			step([{ id: "4", name: NAME, args: { path: "4" } }]),
			text("Sigo sem essa tool."),
		]);
		expect(result.text).toContain("Sigo");
		expect(notFound).toHaveBeenCalledTimes(3);
		expect(toolResults[3]?.summary).toMatch(/indisponível neste run/);
	});
});

describe("F4 - run travado termina com resumo (chamada final sem tools)", () => {
	const tools = ["navigate", "type", "key"] as const;
	const manager = {
		execNavigate: vi.fn(async () => {
			throw new Error("site fora do ar");
		}),
		execType: vi.fn(async () => {
			throw new Error("elemento sumiu");
		}),
		execKey: vi.fn(async () => {
			throw new Error("tecla presa");
		}),
	} as unknown as SandboxManager;
	const argsFor = (name: string, i: number): Record<string, unknown> =>
		name === "navigate"
			? { url: `https://a${i}.com` }
			: name === "type"
				? { text: `t${i}` }
				: { combo: `k${i}` };
	const sixFailingSteps = () =>
		Array.from({ length: 6 }, (_, i) => {
			const name = tools[i % 3] as string;
			return step([{ id: `s${i}`, name, args: argsFor(name, i) }]);
		});

	async function runLocked(finalCall: () => CompleteChatWithToolsResult) {
		const queue = sixFailingSteps();
		const requests: Array<{ toolChoice?: string; last: string }> = [];
		const deltas: string[] = [];
		const promise = runComputerUse({
			manager,
			getSessionId: async () => "session-1",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "abra o site e vai no desktop" }],
			runId: "run-locked",
			maxSteps: 20,
			onEvent: (event) => {
				if (event.type === "assistant_delta") deltas.push(event.delta);
			},
			streamChat: async (request) => {
				const lastMessage = request.messages[request.messages.length - 1];
				requests.push({
					toolChoice: request.toolChoice,
					last: typeof lastMessage?.content === "string" ? lastMessage.content : "",
				});
				return queue.shift() ?? finalCall();
			},
		});
		return { promise, requests, deltas };
	}

	it("trava global gera a mensagem final pela chamada sem tools", async () => {
		const { promise, requests } = await runLocked(() =>
			text("Fiz X, falta Y; tente Z."),
		);
		const error = await promise.catch((e: unknown) => e);
		expect(error).toMatchObject({
			name: "AgentRunLoopDetectedError",
			finalText: "Fiz X, falta Y; tente Z.",
		});
		expect((error as Error).message).toMatch(/6 ferramentas falharam em sequência/);
		const final = requests[requests.length - 1];
		expect(requests).toHaveLength(7);
		expect(final?.toolChoice).toBe("none");
		expect(final?.last).toContain("You could not finish the task because");
		expect(final?.last).toContain("6 ferramentas falharam");
		expect(final?.last).toContain("what is still missing");
	});

	it("se a chamada final falha, mantem o comportamento antigo (sem finalText)", async () => {
		const { promise } = await runLocked(() => {
			throw new Error("LLM fora do ar");
		});
		const error = await promise.catch((e: unknown) => e);
		expect((error as Error).message).toMatch(/6 ferramentas falharam em sequência/);
		expect((error as { finalText?: string }).finalText).toBeUndefined();
	});

	it("limite duro de passos tambem gera o resumo", async () => {
		const navigate = vi.fn(async () => ({ url: "x", title: "y" }));
		const requests: Array<{ toolChoice?: string }> = [];
		const queue = [step([{ id: "n1", name: "navigate", args: { url: "https://a.com" } }])];
		const error = await runComputerUse({
			manager: { execNavigate: navigate } as unknown as SandboxManager,
			getSessionId: async () => "session-1",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "abra o site e vai no desktop" }],
			runId: "run-hard",
			maxSteps: 1,
			onEvent: () => undefined,
			streamChat: async (request) => {
				requests.push({ toolChoice: request.toolChoice });
				return queue.shift() ?? text("Abri a pagina; falta extrair os dados.");
			},
		}).catch((e: unknown) => e);
		expect(error).toMatchObject({
			name: "BudgetExhaustedError",
			finalText: "Abri a pagina; falta extrair os dados.",
		});
		expect(requests[requests.length - 1]?.toolChoice).toBe("none");
	});

	it("tempo esgotado: so a chamada final de resumo (sem tools); se ela falha, texto pt-BR com o caminho de continuar", async () => {
		const streamChat = vi.fn();
		const error = await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => "session-1",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "abra o site e vai no desktop" }],
			runId: "run-wall",
			maxSteps: 5,
			budget: { maxWallMs: 1000 },
			runStartedAt: Date.now() - 10 * 60 * 1000,
			onEvent: () => undefined,
			streamChat,
		}).catch((e: unknown) => e);
		expect(error).toMatchObject({ name: "BudgetExhaustedError" });
		expect((error as { finalText?: string }).finalText).toMatch(/continuar/);
		expect(streamChat).toHaveBeenCalledTimes(1);
		expect(streamChat.mock.calls[0]?.[0]).toMatchObject({ toolChoice: "none" });
	});
});

describe("avisos de lote vão depois dos tool results", () => {
	async function runCapturing(
		mcpCall: McpRuntime["call"],
		queue: CompleteChatWithToolsResult[],
		connectors: Array<typeof github> = [github],
	) {
		const requests: LlmMessage[][] = [];
		let error: unknown;
		try {
			await runComputerUse({
				manager: {} as SandboxManager,
				getSessionId: async () => {
					throw new Error("nao deve criar sessao");
				},
				sandboxEnabled: false,
				model: "test-model",
				apiKey: "test",
				messages: [{ role: "user", content: "revise o repo" }],
				runId: "run-batch-warn",
				maxSteps: 30,
				mcp: { toolset: buildMcpToolset(connectors), call: mcpCall },
				onEvent: () => {},
				streamChat: async (request) => {
					requests.push([...request.messages]);
					const next = queue.shift();
					if (!next) throw new Error("LLM extra");
					return next;
				},
			});
		} catch (e) {
			error = e;
		}
		return { error, requests };
	}

	it("tool bloqueada no meio do lote: nenhum system entre assistant(tool_calls) e seus tool results", async () => {
		const notFound = vi.fn(async () => ({ ok: false, text: "Not Found (404)", truncated: false }));
		const { requests } = await runCapturing(notFound, [
			step([{ id: "c1", name: NAME, args: { path: "1" } }]),
			step([{ id: "c2", name: NAME, args: { path: "2" } }]),
			step([
				{ id: "c3", name: NAME, args: { path: "3" } },
				{ id: "c4", name: NAME, args: { path: "4" } },
			]),
			text("Sigo sem essa tool."),
		]);
		const messages = requests[3]!;
		const at = messages.findIndex((m) => m.role === "assistant" && m.tool_calls?.length === 2);
		expect(at).toBeGreaterThan(-1);
		expect(messages.slice(at + 1, at + 3).map((m) => m.role)).toEqual(["tool", "tool"]);
		const warning = messages[at + 3];
		expect(warning?.role).toBe("system");
		expect(warning?.content).toMatch(
			new RegExp(`^Tool ${NAME} became unavailable in this run after 3 failures: .*\. Use an alternative or continue with what you have\.$`),
		);
	});

	it("ciclo A,B,C x3 avisa depois dos tool results; repetir A,B,C aborta com o erro de loop", async () => {
		const ok = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
			ok: true,
			text: `content of ${String(args.path)}`,
			truncated: false,
		}));
		const cycle = (suffix: string) => ["a", "b", "c"].map((n) => step3(n, suffix));
		const writer = {
			...github,
			id: "conn-w",
			slug: "w",
			confirmWrites: false,
			tools: ["a", "b", "c"].map((n) => ({
				name: `tool_${n}`,
				description: "Tool",
				inputSchema: { type: "object", properties: { path: { type: "string" } } },
				annotations: { readOnlyHint: true },
			})),
		};
		const step3 = (n: string, suffix: string) =>
			step([{ id: `${n}-${suffix}`, name: `mcp__w__tool_${n}`, args: { path: n, runtime_refresh: true } }]);
		const { error, requests } = await runCapturing(ok, [
			...cycle("1"),
			...cycle("2"),
			...cycle("3"),
			...cycle("4"),
			text("nunca chega"),
		], [writer]);
		// 10º pedido ao modelo: já inclui o aviso do ciclo, logo após o último tool result.
		const messages = requests[9]!;
		const last = messages.length - 1;
		expect(messages[last]?.role).toBe("system");
		expect(messages[last]?.content).toMatch(/Period-3 loop/);
		expect(messages[last - 1]?.role).toBe("tool");
		expect(error).toMatchObject({ name: "AgentRunLoopDetectedError" });
		expect(String((error as Error).message)).toMatch(/Period-3 loop/);
	});
});
