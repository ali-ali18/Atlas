import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult, LlmMessage } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { languageInstruction } from "@workspace/shared";
import { disciplineForModel } from "./context/model-discipline.js";
import {
	createRoutine,
	convertRoutineToGenericWebhook,
	deleteRoutine,
	getBotProfile,
	listRoutines,
	persistConversationCardFromEvent,
	saveSkillPendingIntent,
	findExecutedConfirmCall,
	updateRoutine,
} from "@workspace/db";
import { budgetStopFallbackText, CONNECTOR_ARGS_GUIDANCE } from "./computer-use.js";
import { parseRuntimeCheckpoint } from "./checkpoint.js";
import { buildMcpToolset } from "./mcp/registry.js";
import type { McpRuntime } from "./mcp/runtime.js";
import { ensureGithubRepoHook } from "./github/hook-sync.js";
import {
	SYSTEM_PROMPT,
	parseProposeProfileArgs,
	parseProposeQuestionnaireArgs,
	runComputerUse,
	sanitizeAssistantText,
} from "./computer-use.js";

vi.mock("@workspace/db", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		searchMemoryEntries: async () => [
			{
				entry: {
					id: "mem-1",
					target: "memory",
					content: "Usuario prefere modo escuro a noite.",
					category: "preferencia",
					createdAt: new Date(0).toISOString(),
					updatedAt: new Date(0).toISOString(),
				},
				score: 0.05,
				via: "vector",
			},
		],
		// Default: sem bot cadastrado -> `onboardingIncomplete` true -> gate de
		// `propose_profile_update` liberado por padrão (preserva o comportamento
		// dos testes que não giram em torno do gate). Testes de A2 sobrescrevem
		// com `vi.mocked(getBotProfile).mockResolvedValueOnce(...)`.
		getBotProfile: vi.fn(async () => null),
		saveSkillPendingIntent: vi.fn(async () => undefined),
		findExecutedConfirmCall: vi.fn(async () => null),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		listRoutines: vi.fn(async () => []),
		createRoutine: vi.fn(),
		convertRoutineToGenericWebhook: vi.fn(),
		updateRoutine: vi.fn(),
		deleteRoutine: vi.fn(async () => true),
		getRoutineGithubTrigger: vi.fn(async () => null),
	};
});

vi.mock("./github/hook-sync.js", () => ({
	ensureGithubRepoHook: vi.fn(async () => ({ ok: true })),
}));

function toolCall(
	id: string,
	name: string,
	args: Record<string, unknown>,
): CompleteChatWithToolsResult {
	return {
		model: "test-model",
		message: {
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id,
					type: "function",
					function: { name, arguments: JSON.stringify(args) },
				},
			],
		},
	};
}

function assistantWithNavigate(): CompleteChatWithToolsResult {
	return {
		model: "test-model",
		message: {
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: "call_nav_1",
					type: "function",
					function: {
						name: "navigate",
						arguments: JSON.stringify({ url: "https://example.com" }),
					},
				},
			],
		},
	};
}

function assistantDone(): CompleteChatWithToolsResult {
	return {
		model: "test-model",
		message: {
			role: "assistant",
			content: "Pronto, abri o site.",
		},
	};
}

describe("runComputerUse resume", () => {
	it.each(["pt-BR", "en-US", "es-ES"] as const)(
		"adds the %s language instruction to a fresh run",
		async (language) => {
			let systemContent = "";
			await runComputerUse({
				manager: {} as SandboxManager,
				getSessionId: async () => "session-1",
				model: "test-model",
				apiKey: "test",
				messages: [{ role: "user", content: "hello" }],
				language,
				maxSteps: 1,
				onEvent: () => undefined,
				streamChat: async (request) => {
					systemContent = String(request.messages.find((message) => message.role === "system")?.content);
					return assistantDone();
				},
			});
			// Persona no topo: identidade, estilo e idioma num lugar só (uma vez).
			expect(systemContent.startsWith("Persona:\n")).toBe(true);
			expect(systemContent.split(languageInstruction(language))).toHaveLength(2);
			expect(systemContent.indexOf(languageInstruction(language))).toBeLessThan(systemContent.indexOf("Act, don't ask:"));
		},
	);

	it("bot en-US nunca recebe 'português' no prompt; pt-BR recebe Portuguese", async () => {
		const systemOf = async (language: "en-US" | "pt-BR") => {
			let systemContent = "";
			await runComputerUse({
				manager: {} as SandboxManager,
				getSessionId: async () => "session-1",
				sandboxEnabled: false,
				model: "test-model",
				apiKey: "test",
				messages: [{ role: "user", content: "hello" }],
				language,
				maxSteps: 1,
				onEvent: () => undefined,
				streamChat: async (request) => {
					systemContent = request.messages.filter((message) => message.role === "system").map((message) => String(message.content)).join("\n");
					return assistantDone();
				},
			});
			return systemContent;
		};
		const en = await systemOf("en-US");
		expect(en).not.toMatch(/portugu[eê]s|Responda em/i);
		expect(en).toContain("Always reply to the user in American English.");
		expect(await systemOf("pt-BR")).toContain("Always reply to the user in Brazilian Portuguese.");
	});

	it.each([
		[{ role: "user" as const, content: "hello" }],
		[
			{ role: "system" as const, content: `Original prompt\n${languageInstruction("es-ES")}` },
			{ role: "user" as const, content: "hello" },
		],
	])("keeps exactly one language instruction on checkpoint resume", async (llmMessages) => {
		let systemContent = "";
		await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => "session-1",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "hello" }],
			language: "es-ES",
			maxSteps: 1,
			onEvent: () => undefined,
			restoredCheckpoint: { messages: [{ role: "user", content: "hello" }], llmMessages },
			streamChat: async (request) => {
				systemContent = String(request.messages.find((message) => message.role === "system")?.content);
				return assistantDone();
			},
		});
		expect(systemContent.split(languageInstruction("es-ES"))).toHaveLength(2);
	});

	it("não reexecuta ferramenta já persistida após crash", async () => {
		const navigate = vi.fn(async () => ({
			url: "https://example.com",
			title: "Example",
		}));
		const manager = {
			execNavigate: navigate,
		} as unknown as SandboxManager;

		const llmQueue = [assistantWithNavigate(), assistantDone()];
		const seenSystemContent: string[] = [];
		const streamChat = async (request: { messages: LlmMessage[] }) => {
			seenSystemContent.push(String(request.messages.find((message) => message.role === "system")?.content));
			const next = llmQueue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		};

		let stored: unknown;
		const completed = new Map<
			string,
			{ summary: string; ok: boolean }
		>();

		const first = runComputerUse({
			manager,
			getSessionId: async () => "session-1",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "abra example.com" }],
			language: "en-US",
			runId: "run-1",
			maxSteps: 4,
			onEvent: () => undefined,
			streamChat,
			findCompletedTool: async (key) => completed.get(key) ?? null,
			onStep: async (step) => {
				if (
					step.idempotencyKey &&
					(step.type === "tool_result" || step.type === "tool") &&
					step.status === "completed"
				) {
					const output = step.outputJson as {
						summary?: string;
						ok?: boolean;
					};
					if (typeof output?.summary === "string") {
						completed.set(step.idempotencyKey, {
							summary: output.summary,
							ok: output.ok !== false,
						});
					}
				}
			},
			onCheckpoint: async (checkpoint) => {
				stored = checkpoint;
			},
			shouldContinue: async () => {
				if (navigate.mock.calls.length >= 1 && completed.size >= 1) {
					throw new Error("crash after tool");
				}
				return true;
			},
		});

		await expect(first).rejects.toThrow(/crash after tool/);
		expect(seenSystemContent[0]).toContain(languageInstruction("en-US"));
		expect(navigate).toHaveBeenCalledTimes(1);
		expect(parseRuntimeCheckpoint(stored)?.nextStepIndex).toBe(1);

		llmQueue.length = 0;
		llmQueue.push(assistantDone());

		const result = await runComputerUse({
			manager,
			getSessionId: async () => "session-1",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "abra example.com" }],
			language: "es-ES",
			runId: "run-1",
			maxSteps: 4,
			onEvent: () => undefined,
			streamChat,
			restoredCheckpoint: parseRuntimeCheckpoint(stored),
			findCompletedTool: async (key) => completed.get(key) ?? null,
			onCheckpoint: async (checkpoint) => {
				stored = checkpoint;
			},
		});

		expect(navigate).toHaveBeenCalledTimes(1);
		expect(seenSystemContent[1]?.split(languageInstruction("es-ES"))).toHaveLength(2);
		expect(seenSystemContent[1]).not.toContain(languageInstruction("en-US"));
		expect(result.text).toContain("Pronto");
	});

	it("remove markup DSML full-width (pipe U+FF5C do DeepSeek)", () => {
		const raw = [
			"<｜DSML｜ calls>",
			'<｜DSML｜ invoke name="scroll">',
			'<｜DSML｜ parameter name="deltaY" string="false">900</｜DSML｜ parameter>',
			"</｜DSML｜ invoke>",
			"</｜DSML｜ calls>",
		].join("\n");
		expect(sanitizeAssistantText(raw)).toBe("");
		expect(
			sanitizeAssistantText(
				"Resultado: ok\n<|DSML| calls>\nfoo\n</|DSML| calls>\nFim",
			),
		).toBe("Resultado: ok\n\nFim");
		expect(sanitizeAssistantText("o que é DSML?")).toBe("o que é DSML?");
	});

	it("falha de sandbox vira mensagem acionável e avisa onSandboxError", async () => {
		const manager = {
			execNavigate: async () => {
				throw new Error("fetch failed");
			},
		} as unknown as SandboxManager;
		const toolResults: string[] = [];
		const sandboxErrors: Array<{ toolName: string; message: string }> = [];
		const llmQueue = [assistantWithNavigate(), assistantDone()];
		const result = await runComputerUse({
			manager,
			getSessionId: async () => "session-1",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "abra example.com" }],
			runId: "run-sandbox-err",
			maxSteps: 4,
			onEvent: (event) => {
				if (event.type === "tool_result") toolResults.push(event.summary);
			},
			streamChat: async () => {
				const next = llmQueue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
			onSandboxError: async (toolName, message) => {
				sandboxErrors.push({ toolName, message });
			},
		});
		expect(result.text).toContain("Pronto");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toMatch(/browser_snapshot/);
		expect(toolResults[0]).not.toMatch(/repita/i);
		expect(toolResults[0]).not.toMatch(/^fetch failed$/);
		expect(sandboxErrors).toEqual([
			{ toolName: "navigate", message: "fetch failed" },
		]);
	});

	it("ingere steer antes da próxima decisão", async () => {
		const calls: LlmMessage[][] = [];
		const streamChat = async (params: { messages: LlmMessage[] }) => {
			calls.push(params.messages);
			return assistantDone();
		};
		const result = await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => "session-1",
			sandboxEnabled: false,
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "objetivo" }],
			runId: "run-steer",
			maxSteps: 2,
			onEvent: () => undefined,
			streamChat,
			consumeSteerInputs: async () => [
				{ id: "in-1", content: "foque no título" },
			],
		});
		expect(result.text).toContain("Pronto");
		const firstCall = calls[0] ?? [];
		expect(
			firstCall.some(
				(message) =>
					typeof message.content === "string" &&
					message.content.includes("foque no título"),
			),
		).toBe(true);
	});

	it("todo passo pede o modelo do run, mesmo após o OpenRouter reportar o fallback", async () => {
		const requested: string[] = [];
		const llmQueue: CompleteChatWithToolsResult[] = [
			// O provider caiu no fallback neste passo e reportou outro modelo.
			{ ...toolCall("call_ms_1", "memory_search", { query: "x" }), model: "fallback/luna" },
			assistantDone(),
		];
		const result = await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => "session-1",
			sandboxEnabled: false,
			model: "anthropic/claude-sonnet-5.5",
			apiKey: "test",
			messages: [{ role: "user", content: "o que voce lembra?" }],
			runId: "run-sticky-model",
			maxSteps: 4,
			onEvent: () => undefined,
			streamChat: async (request) => {
				requested.push(request.model);
				const next = llmQueue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		expect(requested).toEqual([
			"anthropic/claude-sonnet-5.5",
			"anthropic/claude-sonnet-5.5",
		]);
		expect(result.text).toContain("Pronto");
	});

	it("read tools respondem sem banco real", async () => {
		const summaries: string[] = [];
		const llmQueue = [
			toolCall("call_ms_1", "memory_search", { query: "modo escuro" }),
			toolCall("call_cp_1", "checkpoint_read", {}),
			toolCall("call_ar_1", "artifact_read", {}),
			assistantDone(),
		];
		const result = await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => {
				throw new Error("nao deve criar sessao");
			},
			sandboxEnabled: false,
			// Testa o corpo das 3 tools de leitura (memória, checkpoint, artefato); o grupo
			// "references" só carrega por resultado por referência, então roda no modo completo.
			contextEconomy: false,
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "o que voce lembra?" }],
			runId: "run-read-tools",
			maxSteps: 6,
			onEvent: (event) => {
				if (event.type === "tool_result") summaries.push(event.summary);
			},
			streamChat: async () => {
				const next = llmQueue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		expect(result.text).toContain("Pronto");
		expect(summaries).toHaveLength(3);
		expect(summaries[0]).toContain("modo escuro");
		expect(summaries[1]).toMatch(/Passo atual: \d+/);
		expect(summaries[2]).toMatch(/Nenhum screenshot/);
	});

	it("repetição: 3ª avisa e executa, 4ª aborta", async () => {
		const navigate = vi.fn(async () => ({
			url: "https://example.com/ml",
			title: "ML",
		}));
		const manager = { execNavigate: navigate } as unknown as SandboxManager;
		const sameCall = (id: string) =>
			toolCall(id, "navigate", { url: "https://example.com/ml" });
		const llmQueue = [
			sameCall("c1"),
			sameCall("c2"),
			sameCall("c3"),
			sameCall("c4"),
		];
		const events: string[] = [];
		await expect(
			runComputerUse({
				manager,
				getSessionId: async () => "session-1",
				model: "test-model",
				apiKey: "test",
				messages: [{ role: "user", content: "abra o site e ache no ML" }],
				runId: "run-loop",
				maxSteps: 10,
				onEvent: (event) => {
					if (event.type === "tool_call") events.push(event.name);
				},
				streamChat: async () => {
					const next = llmQueue.shift();
					if (!next) throw new Error("LLM extra");
					return next;
				},
			}),
		).rejects.toThrow(/repetindo.*navigate/);
		// 3 execuções (a 3ª com aviso em sistema) + 4ª abortada antes de executar.
		expect(navigate).toHaveBeenCalledTimes(3);
		expect(events).toHaveLength(3);
	});

	it("ordem de chaves não engana o detector", async () => {
		const navigate = vi.fn(async () => ({ url: "x", title: "y" }));
		const manager = { execNavigate: navigate } as unknown as SandboxManager;
		const llmQueue = [
			toolCall("c1", "navigate", { url: "https://a.com", extra: 1 }),
			toolCall("c2", "navigate", { extra: 1, url: "https://a.com" }),
			toolCall("c3", "navigate", { url: "https://a.com", extra: 1 }),
			toolCall("c4", "navigate", { extra: 1, url: "https://a.com" }),
		];
		await expect(
			runComputerUse({
				manager,
				getSessionId: async () => "session-1",
				model: "test-model",
				apiKey: "test",
				messages: [{ role: "user", content: "abra o site e vai" }],
				runId: "run-loop-order",
				maxSteps: 10,
				onEvent: () => undefined,
				streamChat: async () => {
					const next = llmQueue.shift();
					if (!next) throw new Error("LLM extra");
					return next;
				},
			}),
		).rejects.toThrow(/repetindo/);
		expect(navigate).toHaveBeenCalledTimes(3);
	});

	it("o teto de passos fala no idioma do run (en-US e es-ES), e o fechamento padrão também", async () => {
		const run = async (language: "en-US" | "es-ES") => {
			const navigate = vi.fn(async () => ({ url: "x", title: "y" }));
			const manager = { execNavigate: navigate } as unknown as SandboxManager;
			const llmQueue = [toolCall("w1", "navigate", { url: "https://a.com" }), toolCall("w2", "navigate", { url: "https://b.com" }), assistantDone()];
			return runComputerUse({
				manager,
				getSessionId: async () => "session-1",
				model: "test-model",
				apiKey: "test",
				messages: [{ role: "user", content: "open the site" }],
				language,
				runId: "run-wall",
				maxSteps: 2,
				onEvent: () => undefined,
				streamChat: async () => {
					const next = llmQueue.shift();
					if (!next) throw new Error("LLM extra");
					return next;
				},
			}).catch((error: unknown) => error as Error);
		};
		const en = await run("en-US");
		expect(en.message).toBe("the limit of 2 steps was reached");
		expect(budgetStopFallbackText(en.message, "en-US")).toBe('I stopped because the limit of 2 steps was reached. What was already done is saved in this conversation. Reply "continue" and I will pick up where I left off.');
		expect((await run("es-ES")).message).toBe("se alcanzó el límite de 2 pasos");
	});

	it("sinaliza esgotamento ao bater no teto de passos", async () => {
		const navigate = vi.fn(async () => ({ url: "x", title: "y" }));
		const manager = { execNavigate: navigate } as unknown as SandboxManager;
		const llmQueue = [
			toolCall("w1", "navigate", { url: "https://a.com" }),
			toolCall("w2", "navigate", { url: "https://b.com" }),
			assistantDone(),
		];
		await expect(
			runComputerUse({
				manager,
				getSessionId: async () => "session-1",
				model: "test-model",
				apiKey: "test",
				messages: [{ role: "user", content: "abra o site e vai" }],
				runId: "run-wall",
				maxSteps: 2,
				onEvent: () => undefined,
				streamChat: async () => {
					const next = llmQueue.shift();
					if (!next) throw new Error("LLM extra");
					return next;
				},
			}),
		).rejects.toThrow(/passos esgotado/);
		expect(navigate).toHaveBeenCalledTimes(2);
	});

	it("mérito antes do muro não marca hitWall", async () => {
		const result = await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => "session-1",
			sandboxEnabled: false,
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "oi" }],
			runId: "run-merit",
			maxSteps: 4,
			onEvent: () => undefined,
			streamChat: async () => assistantDone(),
		});
		expect(result.hitWall).toBe(false);
	});

	it("avaliação soft conclui cedo sem gastar o teto", async () => {
		let calls = 0;
		const llmQueue = [
			toolCall("s1", "navigate", { url: "https://a.com" }),
			{
				model: "test-model",
				message: {
					role: "assistant" as const,
					content:
						'{"concluded": true, "summary": "Achei o essencial e parei."}',
				},
			},
		];
		const navigate = vi.fn(async () => ({ url: "x", title: "y" }));
		const result = await runComputerUse({
			manager: { execNavigate: navigate } as unknown as SandboxManager,
			getSessionId: async () => "session-1",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "abra o site e vai" }],
			runId: "run-soft-done",
			maxSteps: 4,
			budget: { softMaxSteps: 1, hardMaxSteps: 4 },
			onEvent: () => undefined,
			streamChat: async () => {
				calls += 1;
				const next = llmQueue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		expect(result.text).toContain("Achei o essencial");
		expect(result.hitWall).toBe(false);
		expect(calls).toBe(2);
		expect(navigate).toHaveBeenCalledTimes(1);
	});

	it("avaliação soft continua e estende o teto com evidência", async () => {
		const llmQueue = [
			toolCall("e1", "navigate", { url: "https://a.com" }),
			{
				model: "test-model",
				message: {
					role: "assistant" as const,
					content: '{"concluded": false, "continueReason": "falta ler o resultado"}',
				},
			},
			toolCall("e2", "navigate", { url: "https://b.com" }),
			assistantDone(),
		];
		const navigate = vi.fn(async () => ({ url: "x", title: "y" }));
		let calls = 0;
		const result = await runComputerUse({
			manager: { execNavigate: navigate } as unknown as SandboxManager,
			getSessionId: async () => "session-1",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "abra o site e vai" }],
			runId: "run-soft-continue",
			maxSteps: 20,
			budget: { softMaxSteps: 1, hardMaxSteps: 20, extensionSteps: 8 },
			onEvent: () => undefined,
			streamChat: async () => {
				calls += 1;
				const next = llmQueue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		expect(result.text).toContain("Pronto");
		expect(result.hitWall).toBe(false);
		expect(calls).toBe(4);
	});

	it("JSON inválido na avaliação não estende o bloco", async () => {
		const events: Array<{ type: string; delta?: string }> = [];
		const navigate = vi.fn(async () => ({ url: "x", title: "y" }));
		const llmQueue = [
			toolCall("j1", "navigate", { url: "https://a.com" }),
			{
				model: "test-model",
				message: { role: "assistant" as const, content: "isto não é json" },
			},
			{
				model: "test-model",
				message: { role: "assistant" as const, content: "ainda inválido" },
			},
			toolCall("j2", "navigate", { url: "https://b.com" }),
		];
		await expect(
			runComputerUse({
				manager: { execNavigate: navigate } as unknown as SandboxManager,
				getSessionId: async () => "session-1",
				model: "test-model",
				apiKey: "test",
				messages: [{ role: "user", content: "abra o site e vai" }],
				runId: "run-bad-eval",
				maxSteps: 2,
				budget: { softMaxSteps: 1, hardMaxSteps: 2, extensionSteps: 8 },
				onEvent: (event) => {
					if (event.type === "assistant_delta") {
						events.push({ type: event.type, delta: event.delta });
					}
				},
				streamChat: async () => {
					const next = llmQueue.shift();
					if (!next) throw new Error("LLM extra");
					return next;
				},
			}),
		).rejects.toThrow(/passos esgotado/);
		expect(events.some((item) => item.delta?.includes("concluded"))).toBe(
			false,
		);
		expect(events.some((item) => item.delta?.includes("isto não é json"))).toBe(
			false,
		);
	});

	it("avaliação interna publica só o resumo final, sem JSON", async () => {
		const events: Array<{ id: string; delta: string }> = [];
		const navigate = vi.fn(async () => ({ url: "x", title: "y" }));
		const llmQueue = [
			toolCall("s1", "navigate", { url: "https://a.com" }),
			{
				model: "test-model",
				message: {
					role: "assistant" as const,
					content:
						'{"concluded": true, "summary": "Achei o essencial e parei."}',
				},
			},
		];
		await runComputerUse({
			manager: { execNavigate: navigate } as unknown as SandboxManager,
			getSessionId: async () => "session-1",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "abra o site e vai" }],
			runId: "run-soft-silent",
			maxSteps: 4,
			budget: { softMaxSteps: 1, hardMaxSteps: 4 },
			onEvent: (event) => {
				if (event.type === "assistant_delta") {
					events.push({ id: event.id, delta: event.delta });
				}
			},
			streamChat: async () => {
				const next = llmQueue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		const publicText = events.map((event) => event.delta).join("");
		expect(publicText).toBe("Achei o essencial e parei.");
		expect(publicText).not.toContain("concluded");
		expect(publicText).not.toContain("continueReason");
		expect(events).toHaveLength(1);
		expect(events[0]?.id).toMatch(/-soft-summary$/);
	});

	it("teto de relógio estourado: nenhum passo de trabalho, só a chamada final de resumo", async () => {
		const streamChat = vi.fn();
		await expect(
			runComputerUse({
				manager: {} as SandboxManager,
				getSessionId: async () => "session-1",
				sandboxEnabled: false,
				model: "test-model",
				apiKey: "test",
				messages: [{ role: "user", content: "abra o site e vai" }],
				runId: "run-wall",
				maxSteps: 10,
				budget: { maxWallMs: 1000 },
				runStartedAt: Date.now() - 10 * 60 * 1000,
				onEvent: () => undefined,
				streamChat,
			}),
		).rejects.toThrow(/tempo máximo/);
		expect(streamChat).toHaveBeenCalledTimes(1);
		expect(streamChat.mock.calls[0]?.[0]).toMatchObject({ toolChoice: "none" });
	});

	it("teto de tokens interrompe com diagnóstico", async () => {
		const navigate = vi.fn(async () => ({ url: "x", title: "y" }));
		await expect(
			runComputerUse({
				manager: { execNavigate: navigate } as unknown as SandboxManager,
				getSessionId: async () => "session-1",
				model: "test-model",
				apiKey: "test",
				messages: [{ role: "user", content: "abra o site e vai" }],
				runId: "run-tokens",
				maxSteps: 10,
				budget: { maxTokens: 1 },
				onEvent: () => undefined,
				streamChat: async () => ({
					model: "test-model",
					message: {
						role: "assistant" as const,
						content: null,
						tool_calls: [
							{
								id: "t1",
								type: "function" as const,
								function: {
									name: "navigate",
									arguments: JSON.stringify({ url: "https://a.com" }),
								},
							},
						],
					},
					usage: { promptTokens: 60, completionTokens: 40, totalTokens: 100 },
				}),
			}),
		).rejects.toThrow(/tokens/);
	});

	it("acumula o custo real (usage.cost) dos passos no total do run", async () => {
		const navigate = vi.fn(async () => ({ url: "x", title: "y" }));
		const queue = [
			{ ...toolCall("c1", "navigate", { url: "https://a.com" }), usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, costUsd: 0.12, cachedTokens: 0 } },
			{ ...assistantDone(), usage: { promptTokens: 120, completionTokens: 20, totalTokens: 140, costUsd: 0.03, cachedTokens: 100 } },
		];
		const result = await runComputerUse({
			manager: { execNavigate: navigate } as unknown as SandboxManager,
			getSessionId: async () => "session-1",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "abra o site e vai" }],
			runId: "run-cost",
			maxSteps: 10,
			onEvent: () => undefined,
			streamChat: async () => {
				const next = queue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		expect(result.usage.totalTokens).toBe(250);
		expect(result.usage.costUsd).toBeCloseTo(0.15);
		expect(result.usage.cachedTokens).toBe(100);
	});

	it("teto por ferramenta vira tool_result de erro sem abortar", async () => {
		const navigate = vi.fn(async () => ({ url: "x", title: "y" }));
		const manager = { execNavigate: navigate } as unknown as SandboxManager;
		const mkCall = (id: string, url: string) =>
			toolCall(id, "navigate", { url });
		const toolResults: Array<{ ok: boolean; summary: string }> = [];
		const llmQueue = [
			mkCall("p1", "https://a.com"),
			mkCall("p2", "https://b.com"),
			assistantDone(),
		];
		const result = await runComputerUse({
			manager,
			getSessionId: async () => "session-1",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "abra o site e vai" }],
			runId: "run-toolcap",
			maxSteps: 10,
			budget: { maxCallsPerTool: { navigate: 1 } },
			onEvent: (event) => {
				if (event.type === "tool_result") toolResults.push(event);
			},
			streamChat: async () => {
				const next = llmQueue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		expect(result.text).toContain("Pronto");
		expect(navigate).toHaveBeenCalledTimes(1);
		expect(toolResults).toHaveLength(2);
		expect(toolResults[0]?.ok).toBe(true);
		expect(toolResults[1]?.ok).toBe(false);
		expect(toolResults[1]?.summary).toMatch(/Limite de 1 chamadas de navigate/);
	});

	it("3 falhas da mesma tool bloqueiam e o run continua", async () => {
		const navigate = vi.fn(async () => {
			throw new Error("site fora do ar");
		});
		const manager = { execNavigate: navigate } as unknown as SandboxManager;
		const mkCall = (id: string, url: string) =>
			toolCall(id, "navigate", { url });
		const toolResults: Array<{ ok: boolean; summary: string }> = [];
		const llmQueue = [
			mkCall("f1", "https://a.com"),
			mkCall("f2", "https://b.com"),
			mkCall("f3", "https://c.com"),
			mkCall("f4", "https://d.com"),
			assistantDone(),
		];
		const result = await runComputerUse({
			manager,
			getSessionId: async () => "session-1",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "abra o site e vai" }],
			runId: "run-failseq",
			maxSteps: 10,
			onEvent: (event) => {
				if (event.type === "tool_result") toolResults.push(event);
			},
			streamChat: async () => {
				const next = llmQueue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		expect(result.text).toContain("Pronto");
		// 3 execuções reais + 4ª bloqueada (sintética, sem executar).
		expect(navigate).toHaveBeenCalledTimes(3);
		expect(toolResults).toHaveLength(4);
		expect(toolResults[3]?.ok).toBe(false);
		expect(toolResults[3]?.summary).toMatch(/indisponível neste run/);
	});

	it("6 falhas com 3+ tools distintas abortam", async () => {
		const navigate = vi.fn(async () => {
			throw new Error("site fora do ar");
		});
		const type = vi.fn(async () => {
			throw new Error("elemento sumiu");
		});
		const key = vi.fn(async () => {
			throw new Error("tecla presa");
		});
		const manager = {
			execNavigate: navigate,
			execType: type,
			execKey: key,
		} as unknown as SandboxManager;
		const llmQueue = [
			toolCall("a1", "navigate", { url: "https://a.com" }),
			toolCall("b1", "type", { text: "x" }),
			toolCall("c1", "key", { combo: "Enter" }),
			toolCall("a2", "navigate", { url: "https://b.com" }),
			toolCall("b2", "type", { text: "y" }),
			toolCall("c2", "key", { combo: "Escape" }),
		];
		await expect(
			runComputerUse({
				manager,
				getSessionId: async () => "session-1",
				model: "test-model",
				apiKey: "test",
				messages: [{ role: "user", content: "abra o site e vai no desktop" }],
				runId: "run-abort6",
				maxSteps: 10,
				onEvent: () => undefined,
				streamChat: async () => {
					const next = llmQueue.shift();
					if (!next) throw new Error("LLM extra");
					return next;
				},
			}),
		).rejects.toThrow(/6 ferramentas falharam em sequência/);
		expect(navigate).toHaveBeenCalledTimes(2);
	});
});

describe("parseProposeProfileArgs", () => {
	it("aceita patch parcial e normaliza espaços", () => {
		expect(
			parseProposeProfileArgs({
				description: "  Assistente   do dia a dia  ",
				snippet: "Assistente do dia a dia",
			}),
		).toEqual({
			description: "Assistente do dia a dia",
			snippet: "Assistente do dia a dia",
		});
	});

	it("aceita description null explícito (limpar briefing)", () => {
		expect(parseProposeProfileArgs({ description: null })).toEqual({
			description: null,
		});
	});

	it("recusa proposta vazia", () => {
		expect(() => parseProposeProfileArgs({})).toThrow(/nada para propor/i);
		expect(() => parseProposeProfileArgs({ name: "   " })).toThrow(
			/nada para propor/i,
		);
	});
});

describe("conectores MCP no run", () => {
	const notion = {
		id: "conn-1",
		slug: "notion",
		name: "Notion",
		disabledTools: [],
		confirmWrites: true,
		tools: [
			{
				name: "search",
				description: "Busca páginas",
				inputSchema: { type: "object", properties: { query: { type: "string" } } },
				annotations: { readOnlyHint: true },
			},
			{
				name: "create-page",
				description: "Cria página",
				inputSchema: { type: "object", properties: { title: { type: "string" } } },
			},
		],
	};

	function fakeMcp(call = vi.fn(async () => ({ ok: true, text: "3 páginas", truncated: false }))): McpRuntime {
		return { toolset: buildMcpToolset([notion]), call };
	}

	async function runWith(input: {
		mcp: McpRuntime;
		calls: CompleteChatWithToolsResult[];
		origin?: string;
	}) {
		const seenTools: string[][] = [];
		const seenSystem: string[] = [];
		const toolResults: Array<{ name: string; ok: boolean; summary: string }> = [];
		const confirms: Array<{ title: string; description?: string }> = [];
		const queue = [...input.calls];
		const result = await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => {
				throw new Error("nao deve criar sessao");
			},
			sandboxEnabled: false,
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "mexe no notion" }],
			conversationId: "conv-mcp",
			runId: "run-mcp",
			origin: input.origin,
			maxSteps: 6,
			mcp: input.mcp,
			onEvent: (event) => {
				if (event.type === "tool_result") toolResults.push(event);
				if (event.type === "confirm") confirms.push(event);
			},
			streamChat: async (params) => {
				seenTools.push(params.tools.map((tool) => tool.function.name));
				const system = params.messages[0];
				if (typeof system?.content === "string") seenSystem.push(system.content);
				const next = queue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		return { result, seenTools, seenSystem, toolResults, confirms };
	}

	it("tool de leitura executa direto e o prompt lista o conector", async () => {
		const call = vi.fn(async () => ({ ok: true, text: "3 páginas", truncated: false }));
		const { seenTools, seenSystem, toolResults } = await runWith({
			mcp: fakeMcp(call),
			calls: [toolCall("c1", "mcp__notion__search", { query: "metas" }), assistantDone()],
		});
		expect(seenTools[0]).toContain("mcp__notion__search");
		expect(seenSystem[0]).toContain("Conectores do usuário");
		expect(seenSystem[0]).toContain("Notion");
		expect(seenSystem[0]).toContain("set only the parameters you need");
		expect(seenSystem[0]).toContain("retry with only the main filter");
		expect(seenSystem[0]).toContain("Reuse ids from earlier results");
		expect(seenSystem[0]).toContain("check the tool's inputSchema `required`");
		expect(seenSystem[0]).toContain("Optional fields");
		expect(seenSystem[0]).toContain("never block a create/update call");
		expect(seenSystem[0]).toContain("show the real error");
		expect(seenSystem[0]).toContain("looks inactive or blocked");
		expect(seenSystem[0]).toContain("partial keyword");
		for (const niche of ["proposal", "camomila", "seller"]) {
			expect(seenSystem[0]).not.toContain(niche);
		}
		expect(call).toHaveBeenCalledWith("mcp__notion__search", { query: "metas" }, expect.any(AbortSignal), { refresh: false });
		expect(toolResults[0]).toMatchObject({ name: "mcp__notion__search", ok: true });
		expect(toolResults[0]?.summary).toContain("3 páginas");
		expect(toolResults[0]?.summary).toContain("não confiável");
	});

	it("tool de escrita vira card de confirmação e não executa", async () => {
		vi.mocked(saveSkillPendingIntent).mockClear();
		const call = vi.fn();
		const { toolResults, confirms } = await runWith({
			mcp: fakeMcp(call),
			calls: [toolCall("c1", "mcp__notion__create-page", { title: "Metas Q4" })],
		});
		expect(call).not.toHaveBeenCalled();
		expect(confirms).toHaveLength(1);
		expect(confirms[0]?.title).toBe('Notion: executar "create-page"?');
		expect(confirms[0]?.description).toContain("title: Metas Q4");
		expect(toolResults[0]?.summary).toMatch(/Nada foi executado/);
		expect(saveSkillPendingIntent).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "conv-mcp",
				payload: expect.objectContaining({
					action: "mcp-call",
					mcpCall: expect.objectContaining({
						connectionId: "conn-1",
						toolName: "create-page",
						args: { title: "Metas Q4" },
					}),
				}),
			}),
		);
	});

	it("mesma chamada já aprovada e executada não gera novo card: devolve o resultado guardado", async () => {
		vi.mocked(saveSkillPendingIntent).mockClear();
		vi.mocked(findExecutedConfirmCall).mockResolvedValueOnce({ ok: true, detail: "página criada" });
		const call = vi.fn();
		const { toolResults, confirms } = await runWith({
			mcp: fakeMcp(call),
			calls: [toolCall("c1", "mcp__notion__create-page", { title: "Metas Q4" }), assistantDone()],
		});
		expect(confirms).toHaveLength(0);
		expect(call).not.toHaveBeenCalled();
		expect(saveSkillPendingIntent).not.toHaveBeenCalled();
		expect(toolResults[0]).toMatchObject({ ok: true });
		expect(toolResults[0]?.summary).toContain("já foi aprovada");
		expect(toolResults[0]?.summary).toContain("página criada");
	});

	it("mesma chamada aprovada que falhou devolve o erro, sem novo card", async () => {
		vi.mocked(findExecutedConfirmCall).mockResolvedValueOnce({ ok: false, detail: "calendar_id inválido" });
		const { toolResults, confirms } = await runWith({
			mcp: fakeMcp(vi.fn()),
			calls: [toolCall("c1", "mcp__notion__create-page", { title: "Metas Q4" }), assistantDone()],
		});
		expect(confirms).toHaveLength(0);
		expect(toolResults[0]).toMatchObject({ ok: false });
		expect(toolResults[0]?.summary).toContain("calendar_id inválido");
		expect(toolResults[0]?.summary).toContain("Não repita");
	});

	it("rotina não recebe tools de escrita", async () => {
		const { seenTools } = await runWith({
			mcp: fakeMcp(),
			origin: "routine",
			calls: [assistantDone()],
		});
		expect(seenTools[0]).toContain("mcp__notion__search");
		expect(seenTools[0]).not.toContain("mcp__notion__create-page");
	});

	it("falha do conector vira tool_result com ok=false", async () => {
		const call = vi.fn(async () => ({ ok: false, text: "página não encontrada", truncated: false }));
		const { toolResults } = await runWith({
			mcp: fakeMcp(call),
			calls: [toolCall("c1", "mcp__notion__search", { query: "x" }), assistantDone()],
		});
		expect(toolResults[0]).toMatchObject({ ok: false, summary: "[Notion] página não encontrada" });
	});
});

describe("índice + carregar sob demanda (conectores MCP deferred)", () => {
	// 41 tools no Google Drive (> MCP_MAX_EXPOSED_TOOLS = 40): catálogo não
	// cabe no orçamento ativo, então buildMcpToolset devolve `tools: []` e
	// `deferred: true` — só o índice entra no prompt do passo 1.
	const filler = Array.from({ length: 39 }, (_, i) => ({
		name: `t${i}`,
		description: "Tool de preenchimento",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
	}));
	const drive = {
		id: "conn-drive",
		slug: "google_drive",
		name: "Google Drive",
		disabledTools: [],
		confirmWrites: true,
		tools: [
			...filler,
			{
				name: "search_files",
				description: "Localiza arquivos por nome no Drive",
				inputSchema: { type: "object", properties: { query: { type: "string" } } },
				annotations: { readOnlyHint: true },
			},
			{
				name: "list_recent_files",
				description: "Lista arquivos recentes no Drive",
				inputSchema: { type: "object", properties: {} },
				annotations: { readOnlyHint: true },
			},
		],
	};

	function fakeDeferredMcp(call = vi.fn(async () => ({ ok: true, text: "3 arquivos", truncated: false }))): McpRuntime {
		return { toolset: buildMcpToolset([drive]), call };
	}

	async function runWith(input: {
		mcp: McpRuntime;
		calls: CompleteChatWithToolsResult[];
		restoredCheckpoint?: ReturnType<typeof parseRuntimeCheckpoint>;
		onCheckpoint?: (checkpoint: unknown) => void;
		forcedConnectors?: string[];
		userText?: string;
	}) {
		const seenTools: string[][] = [];
		const seenSystem: string[] = [];
		const toolResults: Array<{ name: string; ok: boolean; summary: string }> = [];
		const queue = [...input.calls];
		const result = await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => {
				throw new Error("nao deve criar sessao");
			},
			sandboxEnabled: false,
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: input.userText ?? "lista os arquivos do drive" }],
			forcedConnectors: input.forcedConnectors,
			conversationId: "conv-mcp-deferred",
			runId: "run-mcp-deferred",
			maxSteps: 6,
			mcp: input.mcp,
			restoredCheckpoint: input.restoredCheckpoint ?? null,
			onEvent: (event) => {
				if (event.type === "tool_result") toolResults.push(event);
			},
			onCheckpoint: input.onCheckpoint
				? async (checkpoint) => input.onCheckpoint?.(checkpoint)
				: undefined,
			streamChat: async (params) => {
				seenTools.push(params.tools.map((tool) => tool.function.name));
				const system = params.messages[0];
				if (typeof system?.content === "string") seenSystem.push(system.content);
				const next = queue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		return { result, seenTools, seenSystem, toolResults };
	}

	it("catálogo grande vira índice no prompt; mcp_tool_search carrega a tool, chamável no passo seguinte", async () => {
		const call = vi.fn(async () => ({ ok: true, text: "3 arquivos", truncated: false }));
		const { seenTools, seenSystem, toolResults } = await runWith({
			mcp: fakeDeferredMcp(call),
			calls: [
				toolCall("c1", "mcp_tool_search", { query: "listar arquivos drive" }),
				toolCall("c2", "mcp__google_drive__search_files", { query: "relatorio" }),
				assistantDone(),
			],
		});

		// Índice compacto no prompt de sistema (não a lista de tools completa).
		expect(seenSystem[0]).toContain("Índice de conectores");
		expect(seenSystem[0]).toContain("Google Drive (41):");
		expect(seenSystem[0]).toContain("search_files");
		expect(seenSystem[0]).toContain("mcp_tool_search");

		// Passo 1: só o host tool de busca está disponível, nada do Drive ainda.
		expect(seenTools[0]).toContain("mcp_tool_search");
		expect(seenTools[0]).not.toContain("mcp__google_drive__search_files");

		// Passo 2: a tool ativada pelo mcp_tool_search já está chamável.
		expect(seenTools[1]).toContain("mcp__google_drive__search_files");

		expect(call).toHaveBeenCalledWith(
			"mcp__google_drive__search_files",
			{ query: "relatorio" },
   expect.any(AbortSignal), { refresh: false },
		);
		expect(toolResults[0]).toMatchObject({ name: "mcp_tool_search", ok: true });
		expect(toolResults[0]?.summary).toContain("mcp__google_drive__search_files");
		expect(toolResults[0]?.summary).toContain("já pode chamar a partir do próximo passo");
		expect(toolResults[1]).toMatchObject({ name: "mcp__google_drive__search_files", ok: true });
	});

	it("@App do usuário (forcedConnectors): as tools do conector entram no 1º passo, sem mcp_tool_search, as do pedido primeiro", async () => {
		const { seenTools } = await runWith({
			mcp: fakeDeferredMcp(),
			forcedConnectors: ["Google Drive"],
			userText: "@Google Drive localiza arquivos do relatorio",
			calls: [assistantDone()],
		});
		expect(seenTools[0]).toContain("mcp__google_drive__search_files");
		expect(seenTools[0]!.filter((name) => name.startsWith("mcp__google_drive__")).length).toBeLessThanOrEqual(20);
	});

	it("sem forcedConnectors ou com conector desconhecido, nada do Drive entra no 1º passo", async () => {
		const plain = await runWith({ mcp: fakeDeferredMcp(), calls: [assistantDone()] });
		expect(plain.seenTools[0]!.some((name) => name.startsWith("mcp__google_drive__"))).toBe(false);
		const unknown = await runWith({ mcp: fakeDeferredMcp(), forcedConnectors: ["Slack"], calls: [assistantDone()] });
		expect(unknown.seenTools[0]!.some((name) => name.startsWith("mcp__google_drive__"))).toBe(false);
	});

	it("resume: reativa tools MCP citadas em tool_calls do checkpoint hidratado", async () => {
		const call = vi.fn(async () => ({ ok: true, text: "3 arquivos", truncated: false }));
		let stored: unknown;
		await runWith({
			mcp: fakeDeferredMcp(call),
			calls: [
				toolCall("c1", "mcp_tool_search", { query: "listar arquivos drive" }),
				toolCall("c2", "mcp__google_drive__search_files", { query: "relatorio" }),
				assistantDone(),
			],
			onCheckpoint: (checkpoint) => {
				stored = checkpoint;
			},
		});

		// Novo McpRuntime (nenhuma tool ativa ainda) retomando o checkpoint: a
		// tool do Drive precisa reaparecer já no passo 1, sem chamar
		// mcp_tool_search de novo.
		const { seenTools } = await runWith({
			mcp: fakeDeferredMcp(call),
			calls: [assistantDone()],
			restoredCheckpoint: parseRuntimeCheckpoint(stored),
		});
		expect(seenTools[0]).toContain("mcp__google_drive__search_files");
	});
});

describe("pesquisa sem chave nem sandbox", () => {
	it("web_search e web_extract existem sem API e usam o provedor nativo", async () => {
		vi.stubEnv("SEARCH_API_KEY", "");
		vi.stubEnv("FIRECRAWL_API_KEY", "");
		// Determinístico: sem SearXNG o nativo usa o DuckDuckGo direto.
		vi.stubEnv("SEARXNG_BASE_URL", "");
		const fetchMock = vi.fn(async () =>
			new Response(
				'<div class="result results_links web-result "><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Floja.com%2Fmac">Mac na Loja</a></div>',
				{ status: 200, headers: { "content-type": "text/html" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const seenTools: string[][] = [];
		const summaries: string[] = [];
		const queue = [toolCall("c1", "web_search", { query: "macbook" }), assistantDone()];
		try {
			await runComputerUse({
				manager: {} as SandboxManager,
				getSessionId: async () => {
					throw new Error("nao deve criar sessao");
				},
				sandboxEnabled: false,
				model: "test-model",
				apiKey: "test",
				messages: [{ role: "user", content: "preço do macbook" }],
				runId: "run-native",
				maxSteps: 4,
				onEvent: (event) => {
					if (event.type === "tool_result") summaries.push(event.summary);
				},
				streamChat: async (params) => {
					seenTools.push(params.tools.map((tool) => tool.function.name));
					const next = queue.shift();
					if (!next) throw new Error("LLM extra");
					return next;
				},
			});
		} finally {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
		}
		expect(seenTools[0]).toEqual(expect.arrayContaining(["web_search", "web_extract"]));
		expect(seenTools[0]).not.toContain("navigate");
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("html.duckduckgo.com");
		expect(summaries[0]).toContain("https://loja.com/mac");
		expect(summaries[0]).toContain("fonte: duckduckgo");
	});
});

describe("propose_routine trigger_type=github", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(listRoutines).mockResolvedValue([]);
		vi.mocked(deleteRoutine).mockResolvedValue(true);
	});

	function fakeGithubRoutine(overrides: Partial<{ id: string; name: string; prompt: string }> = {}) {
		return {
			id: overrides.id ?? "routine-gh-1",
			userId: "default",
			botId: "bot-1",
			conversationId: null,
			name: overrides.name ?? "CI quebrou",
			prompt: overrides.prompt ?? "Leia os logs e diga o que quebrou.",
			model: "",
			enabled: true,
			triggerType: "event" as const,
			schedule: null,
			timezone: "America/Sao_Paulo",
			lastRunAt: null,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		};
	}

	async function runProposeRoutine(args: Record<string, unknown>): Promise<{
		text: string;
		toolResults: { name: string; ok: boolean; summary: string }[];
		routines: { action: string; detail?: string }[];
	}> {
		const toolResults: { name: string; ok: boolean; summary: string }[] = [];
		const routines: { action: string; detail?: string }[] = [];
		const llmQueue: CompleteChatWithToolsResult[] = [
			toolCall("gh-call-1", "propose_routine", args),
			{ model: "test-model", message: { role: "assistant", content: "ok" } },
		];
		const result = await runComputerUse({
			manager: {} as unknown as SandboxManager,
			getSessionId: async () => "session-gh-1",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "me avisa quando o CI falhar na main" }],
			runId: "run-propose-github",
			conversationId: "conv-github-1",
			botId: "bot-1",
			maxSteps: 4,
			onEvent: (event) => {
				if (event.type === "tool_result") {
					toolResults.push({ name: event.name, ok: event.ok, summary: event.summary });
				}
				if (event.type === "routine") {
					routines.push({ action: event.action, detail: event.detail });
				}
			},
			streamChat: async () => {
				const next = llmQueue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		return { text: result.text, toolResults, routines };
	}

	it("cria rotina github com sucesso e emite card", async () => {
		vi.mocked(createRoutine).mockResolvedValueOnce({
			routine: fakeGithubRoutine(),
		} as never);
		vi.mocked(ensureGithubRepoHook).mockResolvedValueOnce({ ok: true });

		const { toolResults, routines } = await runProposeRoutine({
			action: "create",
			title: "CI quebrou",
			detail: "Leia os logs e diga o que quebrou.",
			trigger_type: "github",
			github: { repo: "ali-ali18/Atlas", events: ["ci_failed"], ci_branch: "main" },
		});

		expect(createRoutine).toHaveBeenCalledTimes(1);
		expect(toolResults[0]?.summary).toContain("criada");
		expect(routines).toHaveLength(1);
		expect(routines[0]?.action).toBe("created");
		expect(deleteRoutine).not.toHaveBeenCalled();
	});

	it("erro ao sincronizar o hook: apaga a rotina recém-criada e não emite card", async () => {
		vi.mocked(createRoutine).mockResolvedValueOnce({
			routine: fakeGithubRoutine({ id: "routine-gh-2" }),
		} as never);
		vi.mocked(ensureGithubRepoHook).mockResolvedValueOnce({
			error: "Conecte o GitHub no Marketplace",
		});

		const { toolResults, routines } = await runProposeRoutine({
			action: "create",
			title: "CI quebrou",
			detail: "Leia os logs e diga o que quebrou.",
			trigger_type: "github",
			github: { repo: "ali-ali18/Atlas", events: ["ci_failed"], ci_branch: "main" },
		});

		expect(deleteRoutine).toHaveBeenCalledWith("default", "bot-1", "routine-gh-2");
		expect(routines).toHaveLength(0);
		expect(toolResults[0]?.summary).toContain("Conecte o GitHub no Marketplace");
	});

	it("recusa criar sem branch nem prNumber quando o evento é de CI", async () => {
		const { toolResults, routines } = await runProposeRoutine({
			action: "create",
			title: "CI quebrou",
			detail: "Leia os logs e diga o que quebrou.",
			trigger_type: "github",
			github: { repo: "ali-ali18/Atlas", events: ["ci_failed"] },
		});

		expect(createRoutine).not.toHaveBeenCalled();
		expect(routines).toHaveLength(0);
		expect(toolResults[0]?.summary).toMatch(/branch/);
	});

	it("aceita branch (campo novo) no lugar de ci_branch", async () => {
		vi.mocked(createRoutine).mockResolvedValueOnce({
			routine: fakeGithubRoutine(),
		} as never);
		vi.mocked(ensureGithubRepoHook).mockResolvedValueOnce({ ok: true });

		const { toolResults, routines } = await runProposeRoutine({
			action: "create",
			title: "CI quebrou",
			detail: "Leia os logs e diga o que quebrou.",
			trigger_type: "github",
			github: { repo: "ali-ali18/Atlas", events: ["ci_failed"], branch: "main" },
		});

		expect(createRoutine).toHaveBeenCalledTimes(1);
		expect(toolResults[0]?.summary).toContain("criada");
		expect(routines).toHaveLength(1);
	});

	function fakeCronRoutine(
		overrides: Partial<{ id: string; enabled: boolean; schedule: string | null }> = {},
	) {
		return {
			id: overrides.id ?? "routine-cron-1",
			userId: "default",
			botId: "bot-1",
			conversationId: null,
			name: "Checkpoint watch",
			prompt: "prompt antigo (a cada 6 horas)",
			model: "",
			enabled: overrides.enabled ?? false,
			triggerType: "cron" as const,
			schedule: overrides.schedule ?? "0 */6 * * *",
			timezone: "America/Sao_Paulo",
			lastRunAt: null,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		};
	}

	it("create com nome existente aplica o gatilho GitHub e sincroniza o hook", async () => {
		const cronRoutine = { ...fakeCronRoutine(), name: "CI quebrou" };
		vi.mocked(listRoutines).mockResolvedValue([cronRoutine] as never);
		vi.mocked(updateRoutine).mockResolvedValueOnce({
			...cronRoutine,
			triggerType: "event",
			schedule: null,
			github: { kind: "github", repo: "ali-ali18/Atlas", events: ["ci_failed"], branch: "main" },
		} as never);
		const { routines } = await runProposeRoutine({
			action: "create",
			title: "CI quebrou",
			detail: "Leia os logs",
			trigger_type: "github",
			github: { repo: "ali-ali18/Atlas", events: ["ci_failed"], branch: "main" },
		});
		expect(createRoutine).not.toHaveBeenCalled();
		expect(updateRoutine).toHaveBeenCalledWith("default", "bot-1", cronRoutine.id, expect.objectContaining({
			triggerType: "event",
			githubTrigger: expect.objectContaining({ repo: "ali-ali18/Atlas", events: ["ci_failed"] }),
		}));
		expect(ensureGithubRepoHook).toHaveBeenCalledWith({ userId: "default", repo: "ali-ali18/Atlas" });
		expect(routines).toContainEqual(expect.objectContaining({ action: "updated" }));
	});

	it("create com nome existente converte cron em webhook genérico com secret", async () => {
		const cronRoutine = { ...fakeCronRoutine(), name: "Aviso externo" };
		vi.mocked(listRoutines).mockResolvedValue([cronRoutine] as never);
		vi.mocked(convertRoutineToGenericWebhook).mockResolvedValueOnce({
			routine: { ...cronRoutine, triggerType: "event", schedule: null, hook: { hookKey: "key", url: "https://example.com/hook" } },
			hookSecret: "one-time-secret",
		} as never);
		const { toolResults, routines } = await runProposeRoutine({
			action: "create",
			title: "Aviso externo",
			detail: "Processar evento",
			trigger_type: "event",
		});
		expect(createRoutine).not.toHaveBeenCalled();
		expect(convertRoutineToGenericWebhook).toHaveBeenCalledWith("default", "bot-1", cronRoutine.id, expect.objectContaining({ prompt: "Processar evento" }));
		expect(toolResults[0]?.summary).toContain("one-time-secret");
		expect(routines).toContainEqual(expect.objectContaining({ action: "updated" }));
	});

	it("create com nome existente converte webhook em cron", async () => {
		const webhookRoutine = { ...fakeCronRoutine(), name: "Aviso externo", triggerType: "event" as const, schedule: null, hook: { hookKey: "key" } };
		vi.mocked(listRoutines).mockResolvedValue([webhookRoutine] as never);
		vi.mocked(updateRoutine).mockResolvedValueOnce({ ...webhookRoutine, triggerType: "cron", schedule: "0 9 * * *", hook: undefined } as never);
		await runProposeRoutine({
			action: "create", title: "Aviso externo", detail: "Verificar diariamente", trigger_type: "cron", schedule: "0 9 * * *",
		});
		expect(updateRoutine).toHaveBeenCalledWith("default", "bot-1", webhookRoutine.id, expect.objectContaining({ triggerType: "cron", schedule: "0 9 * * *" }));
	});

	it("edit: resolve o target pelo id (prefill '(id ...)'), troca cron→github e preserva enabled=false (não reativa sozinho)", async () => {
		const cronRoutine = fakeCronRoutine({ enabled: false });
		vi.mocked(listRoutines).mockResolvedValue([cronRoutine] as never);
		vi.mocked(updateRoutine).mockResolvedValueOnce({
			...cronRoutine,
			triggerType: "event",
			schedule: null,
			enabled: false,
			github: {
				kind: "github",
				repo: "ali-ali18/Atlas",
				events: ["push", "pr_opened", "pr_merged"],
				branch: "checkpoint/agentic-baseline",
			},
		} as never);
		vi.mocked(ensureGithubRepoHook).mockResolvedValueOnce({ ok: true });

		const { toolResults } = await runProposeRoutine({
			action: "edit",
			target: "routine-cron-1",
			detail: "instrução nova de leitura do evento",
			trigger_type: "github",
			github: {
				repo: "ali-ali18/Atlas",
				events: ["push", "pr_opened", "pr_merged"],
				branch: "checkpoint/agentic-baseline",
			},
		});

		expect(updateRoutine).toHaveBeenCalledTimes(1);
		const patch = vi.mocked(updateRoutine).mock.calls[0]?.[3];
		expect(patch).toMatchObject({
			triggerType: "event",
			schedule: null,
			enabled: false,
			githubTrigger: {
				repo: "ali-ali18/Atlas",
				events: ["push", "pr_opened", "pr_merged"],
				branch: "checkpoint/agentic-baseline",
			},
		});
		expect(ensureGithubRepoHook).toHaveBeenCalledWith({
			userId: "default",
			repo: "ali-ali18/Atlas",
		});
		expect(toolResults[0]?.ok).toBe(true);
	});

	it("edit: erro ao sincronizar o hook reverte pro trigger cron anterior (não deixa a rotina quebrada)", async () => {
		const cronRoutine = fakeCronRoutine({ enabled: false });
		vi.mocked(listRoutines).mockResolvedValue([cronRoutine] as never);
		vi.mocked(updateRoutine)
			.mockResolvedValueOnce({
				...cronRoutine,
				triggerType: "event",
				schedule: null,
				github: { kind: "github", repo: "ali-ali18/Atlas", events: ["push"], branch: "main" },
			} as never)
			.mockResolvedValueOnce({ ...cronRoutine } as never);
		vi.mocked(ensureGithubRepoHook).mockResolvedValueOnce({
			error: "Conecte o GitHub no Marketplace",
		});

		const { toolResults } = await runProposeRoutine({
			action: "edit",
			target: "routine-cron-1",
			detail: "instrução nova",
			trigger_type: "github",
			github: { repo: "ali-ali18/Atlas", events: ["push"], branch: "main" },
		});

		expect(updateRoutine).toHaveBeenCalledTimes(2);
		const revertPatch = vi.mocked(updateRoutine).mock.calls[1]?.[3];
		expect(revertPatch).toMatchObject({ triggerType: "cron", schedule: "0 */6 * * *" });
		expect(toolResults[0]?.summary).toContain("Conecte o GitHub no Marketplace");
	});

	it("edit: enabled omitido numa rotina já github ativa mantém ativa (não força enabled=true implicitamente sem necessidade nem desliga)", async () => {
		const githubRoutine = {
			...fakeGithubRoutine(),
			enabled: true,
			github: {
				kind: "github" as const,
				repo: "ali-ali18/Atlas",
				events: ["ci_failed"] as const,
				branch: "main",
			},
		};
		vi.mocked(listRoutines).mockResolvedValue([githubRoutine] as never);
		vi.mocked(updateRoutine).mockResolvedValueOnce({ ...githubRoutine } as never);
		vi.mocked(ensureGithubRepoHook).mockResolvedValueOnce({ ok: true });

		await runProposeRoutine({
			action: "edit",
			target: "routine-gh-1",
			detail: "instrução ajustada",
			trigger_type: "github",
			github: { events: ["ci_failed", "ci_passed"] },
		});

		const patch = vi.mocked(updateRoutine).mock.calls[0]?.[3];
		expect(patch).toMatchObject({ enabled: true });
	});

	it("edit: emite evento routine/updated (sem card na timeline) pra web recarregar a lista", async () => {
		const cronRoutine = fakeCronRoutine({ enabled: true });
		vi.mocked(listRoutines).mockResolvedValue([cronRoutine] as never);
		const updated = {
			...cronRoutine,
			prompt: "instrução nova",
			schedule: "0 7 * * *",
		};
		vi.mocked(updateRoutine).mockResolvedValueOnce(updated as never);

		const { routines } = await runProposeRoutine({
			action: "edit",
			target: "routine-cron-1",
			detail: "instrução nova",
			trigger_type: "cron",
			schedule: "0 7 * * *",
		});

		// SSE recebe o evento "updated" (side panel/lista recarrega).
		expect(routines).toContainEqual(
			expect.objectContaining({ action: "updated" }),
		);
		// Mas nenhum card é persistido (edição nunca teve card na timeline).
		expect(
			vi.mocked(persistConversationCardFromEvent).mock.calls.some(
				([, event]) =>
					(event as { type?: string })?.type === "routine",
			),
		).toBe(false);
	});
});

describe("propose_routine trigger_type=once", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(listRoutines).mockResolvedValue([]);
		vi.mocked(deleteRoutine).mockResolvedValue(true);
	});

	const futureRunAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
	const pastRunAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

	function fakeOnceRoutine(
		overrides: Partial<{ id: string; name: string; runAt: string }> = {},
	) {
		return {
			id: overrides.id ?? "routine-once-1",
			userId: "default",
			botId: "bot-1",
			conversationId: null,
			name: overrides.name ?? "Deploy",
			prompt: "Lembra de dar deploy.",
			model: "",
			enabled: true,
			triggerType: "once" as const,
			schedule: null,
			timezone: "America/Sao_Paulo",
			lastRunAt: null,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			once: { runAt: overrides.runAt ?? futureRunAt },
		};
	}

	async function runProposeRoutine(args: Record<string, unknown>): Promise<{
		toolResults: { name: string; ok: boolean; summary: string }[];
		routines: { action: string; detail?: string; triggerType?: string }[];
	}> {
		const toolResults: { name: string; ok: boolean; summary: string }[] = [];
		const routines: { action: string; detail?: string; triggerType?: string }[] = [];
		const llmQueue: CompleteChatWithToolsResult[] = [
			toolCall("once-call-1", "propose_routine", args),
			{ model: "test-model", message: { role: "assistant", content: "ok" } },
		];
		await runComputerUse({
			manager: {} as unknown as SandboxManager,
			getSessionId: async () => "session-once-1",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "me lembra de dar deploy dia 03/10 às 10h" }],
			runId: "run-propose-once",
			conversationId: "conv-once-1",
			botId: "bot-1",
			maxSteps: 4,
			onEvent: (event) => {
				if (event.type === "tool_result") {
					toolResults.push({ name: event.name, ok: event.ok, summary: event.summary });
				}
				if (event.type === "routine") {
					routines.push({ action: event.action, detail: event.detail, triggerType: event.triggerType });
				}
			},
			streamChat: async () => {
				const next = llmQueue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		return { toolResults, routines };
	}

	it("cria lembrete de uma vez só com run_at futuro e emite card", async () => {
		vi.mocked(createRoutine).mockResolvedValueOnce({
			routine: fakeOnceRoutine(),
		} as never);

		const { toolResults, routines } = await runProposeRoutine({
			action: "create",
			title: "Deploy",
			detail: "Lembra de dar deploy.",
			trigger_type: "once",
			run_at: futureRunAt,
		});

		expect(createRoutine).toHaveBeenCalledTimes(1);
		expect(createRoutine).toHaveBeenCalledWith(
			"default",
			expect.objectContaining({
				triggerType: "once",
				trigger: { kind: "once", runAt: expect.any(String) },
			}),
		);
		expect(toolResults[0]?.ok).toBe(true);
		expect(toolResults[0]?.summary).toContain("criado");
		expect(routines).toHaveLength(1);
		expect(routines[0]?.action).toBe("created");
		expect(routines[0]?.triggerType).toBe("once");
	});

	it("recusa criar com run_at no passado e não chama createRoutine", async () => {
		const { toolResults, routines } = await runProposeRoutine({
			action: "create",
			title: "Deploy",
			detail: "Lembra de dar deploy.",
			trigger_type: "once",
			run_at: pastRunAt,
		});

		expect(createRoutine).not.toHaveBeenCalled();
		expect(routines).toHaveLength(0);
		expect(toolResults[0]?.summary).toMatch(/futuro/);
	});

	it("recusa criar sem run_at", async () => {
		const { toolResults, routines } = await runProposeRoutine({
			action: "create",
			title: "Deploy",
			detail: "Lembra de dar deploy.",
			trigger_type: "once",
		});

		expect(createRoutine).not.toHaveBeenCalled();
		expect(routines).toHaveLength(0);
		expect(toolResults[0]?.summary).toMatch(/run_at/);
	});

	it("edit: troca run_at de uma rotina 'once' existente (sem card)", async () => {
		const existing = fakeOnceRoutine();
		vi.mocked(listRoutines).mockResolvedValue([existing] as never);
		const nextRunAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
		vi.mocked(updateRoutine).mockResolvedValueOnce({
			...existing,
			once: { runAt: nextRunAt },
		} as never);

		const { routines } = await runProposeRoutine({
			action: "edit",
			target: "routine-once-1",
			detail: "Lembra de dar deploy.",
			trigger_type: "once",
			run_at: nextRunAt,
		});

		expect(updateRoutine).toHaveBeenCalledWith(
			"default",
			"bot-1",
			"routine-once-1",
			expect.objectContaining({
				triggerType: "once",
				schedule: null,
				onceTrigger: { runAt: expect.any(String) },
			}),
		);
		expect(routines).toContainEqual(expect.objectContaining({ action: "updated" }));
		// Edição nunca tem card na timeline (mesmo padrão de cron/github).
		expect(
			vi.mocked(persistConversationCardFromEvent).mock.calls.some(
				([, event]) => (event as { type?: string })?.type === "routine",
			),
		).toBe(false);
	});
});

describe("replay: 'me lembra de dar deploy dia 03/10 às 10h e às 20h aqui pelo chat' (bug real)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
		vi.clearAllMocks();
		vi.mocked(listRoutines).mockResolvedValue([]);
		// Onboarding já concluído: só assim dá pra provar que
		// propose_profile_update não é oferecida pra um pedido de lembrete.
		vi.mocked(getBotProfile).mockResolvedValue({
			name: "Bot",
			snippet: "",
			description: "Bot de suporte já configurado",
			openRouterModel: null,
			language: "pt-BR",
		} as never);
	});

	/** 03/10 às 10:00 America/Sao_Paulo = 13:00 UTC (fuso fixo, sem DST). */
	afterEach(() => vi.useRealTimers());

	const year = 2026;
	const runAt10 = `${year}-10-03T10:00`;
	const runAt20 = `${year}-10-03T20:00`;
	const expectedUtc10 = new Date(Date.UTC(year, 9, 3, 13, 0, 0)).toISOString();
	const expectedUtc20 = new Date(Date.UTC(year, 9, 3, 23, 0, 0)).toISOString();

	function fakeOnceRoutine(id: string, name: string, runAt: string) {
		return {
			id,
			userId: "default",
			botId: "bot-1",
			conversationId: null,
			name,
			prompt: "Lembra de dar deploy.",
			model: "",
			enabled: true,
			triggerType: "once" as const,
			schedule: null,
			timezone: "America/Sao_Paulo",
			lastRunAt: null,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			once: { runAt },
		};
	}

	it("cria as 2 rotinas 'once' (10h e 20h) certas, sem questionário nem card de perfil", async () => {
		vi.mocked(createRoutine)
			.mockResolvedValueOnce({
				routine: fakeOnceRoutine("routine-deploy-10h", "Deploy 10h", expectedUtc10),
			} as never)
			.mockResolvedValueOnce({
				routine: fakeOnceRoutine("routine-deploy-20h", "Deploy 20h", expectedUtc20),
			} as never);

		const seenTools: string[][] = [];
		const toolResults: { name: string; ok: boolean; summary: string }[] = [];
		const routineEvents: { action: string; triggerType?: string }[] = [];
		const questionnaireEvents: unknown[] = [];
		const profileEvents: unknown[] = [];

		const llmQueue: CompleteChatWithToolsResult[] = [
			{
				model: "test-model",
				message: {
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call-deploy-10h",
							type: "function",
							function: {
								name: "propose_routine",
								arguments: JSON.stringify({
									action: "create",
									title: "Deploy 10h",
									detail: "Lembra de dar deploy.",
									trigger_type: "once",
									run_at: runAt10,
								}),
							},
						},
						{
							id: "call-deploy-20h",
							type: "function",
							function: {
								name: "propose_routine",
								arguments: JSON.stringify({
									action: "create",
									title: "Deploy 20h",
									detail: "Lembra de dar deploy.",
									trigger_type: "once",
									run_at: runAt20,
								}),
							},
						},
					],
				},
			},
			{
				model: "test-model",
				message: {
					role: "assistant",
					content: "Prontinho, marquei os dois lembretes aqui pelo chat.",
				},
			},
		];

		await runComputerUse({
			manager: {} as unknown as SandboxManager,
			getSessionId: async () => "session-deploy-reminder",
			model: "test-model",
			apiKey: "test",
			messages: [
				{
					role: "user",
					content: "me lembra de dar deploy dia 03/10 às 10h e às 20h aqui pelo chat",
				},
			],
			runId: "run-deploy-reminder",
			conversationId: "conv-deploy-reminder",
			botId: "bot-1",
			maxSteps: 4,
			onEvent: (event) => {
				if (event.type === "tool_result") {
					toolResults.push({ name: event.name, ok: event.ok, summary: event.summary });
				}
				if (event.type === "routine") {
					routineEvents.push({ action: event.action, triggerType: event.triggerType });
				}
				if (event.type === "questionnaire") questionnaireEvents.push(event);
				if (event.type === "bot-profile") profileEvents.push(event);
			},
			streamChat: async (params) => {
				seenTools.push(params.tools.map((tool) => tool.function.name));
				const next = llmQueue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});

		expect(createRoutine).toHaveBeenCalledTimes(2);
		expect(createRoutine).toHaveBeenNthCalledWith(
			1,
			"default",
			expect.objectContaining({
				triggerType: "once",
				trigger: { kind: "once", runAt: expectedUtc10 },
			}),
		);
		expect(createRoutine).toHaveBeenNthCalledWith(
			2,
			"default",
			expect.objectContaining({
				triggerType: "once",
				trigger: { kind: "once", runAt: expectedUtc20 },
			}),
		);

		expect(routineEvents).toHaveLength(2);
		expect(
			routineEvents.every((event) => event.action === "created" && event.triggerType === "once"),
		).toBe(true);

		const routineToolResults = toolResults.filter((r) => r.name === "propose_routine");
		expect(routineToolResults).toHaveLength(2);
		expect(routineToolResults.every((r) => r.ok)).toBe(true);
		expect(toolResults.some((r) => r.name === "propose_questionnaire")).toBe(false);

		expect(questionnaireEvents).toHaveLength(0);
		expect(profileEvents).toHaveLength(0);
		expect(seenTools[0]).not.toContain("propose_profile_update");
	});
});

describe("replay: 'me lembra daqui 30 minutos de tomar água' (in_minutes)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-25T17:32:00Z"));
		vi.stubEnv("ATLAS_NOW_NOTE", "on");
		vi.clearAllMocks();
		vi.mocked(listRoutines).mockResolvedValue([]);
		vi.mocked(getBotProfile).mockResolvedValue({
			name: "Bot",
			snippet: "",
			description: "Bot de suporte já configurado",
			openRouterModel: null,
			language: "pt-BR",
		} as never);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("a hora vai numa camada efêmera no fim: o prefixo (sistema e histórico) não muda quando o minuto muda", async () => {
		const ask = async (iso: string) => {
			vi.setSystemTime(new Date(iso));
			const requests: LlmMessage[][] = [];
			await runComputerUse({
				manager: {} as unknown as SandboxManager,
				getSessionId: async () => "session-prefix",
				model: "test-model",
				apiKey: "test",
				messages: [{ role: "user", content: "Bom dia" }],
				runId: "run-prefix",
				conversationId: "conv-prefix",
				botId: "bot-1",
				maxSteps: 2,
				onEvent: () => {},
				streamChat: async (params) => {
					requests.push(params.messages);
					return { model: "test-model", message: { role: "assistant", content: "Bom dia!" } };
				},
			});
			return requests[0]!;
		};
		const early = await ask("2026-10-25T17:32:00Z");
		const later = await ask("2026-10-25T17:40:00Z");
		expect(String(early[0]!.content)).not.toContain("Now is");
		expect(String(early.at(-1)!.content)).toContain("Now is 2026-10-25 14:32");
		expect(String(later.at(-1)!.content)).toContain("Now is 2026-10-25 14:40");
		expect(later.slice(0, -1)).toEqual(early.slice(0, -1));
	});

	it("o fuso da conta (timeZone) chega na nota de hora; inválido cai em São Paulo", async () => {
		const ask = async (timeZone?: string) => {
			const requests: LlmMessage[][] = [];
			await runComputerUse({
				manager: {} as unknown as SandboxManager,
				getSessionId: async () => "session-tz",
				model: "test-model",
				apiKey: "test",
				messages: [{ role: "user", content: "Bom dia" }],
				runId: "run-tz",
				conversationId: "conv-tz",
				botId: "bot-1",
				maxSteps: 2,
				timeZone,
				onEvent: () => {},
				streamChat: async (params) => {
					requests.push(params.messages);
					return { model: "test-model", message: { role: "assistant", content: "Bom dia!" } };
				},
			});
			return String(requests[0]!.at(-1)!.content);
		};
		expect(await ask("Asia/Tokyo")).toContain("Now is 2026-10-26 02:32 (segunda-feira), timezone Asia/Tokyo");
		expect(await ask("Nao/Existe")).toContain("Now is 2026-10-25 14:32 (domingo), timezone America/Sao_Paulo");
	});

	it("a tool recebe in_minutes, o servidor calcula agora+30min e o prompt do passo 1 traz a hora local", async () => {
		const expectedRunAt = "2026-10-25T18:02:00.000Z";
		vi.mocked(createRoutine).mockResolvedValueOnce({
			routine: {
				id: "routine-agua",
				userId: "default",
				botId: "bot-1",
				conversationId: null,
				name: "Tomar água",
				prompt: "Lembra de tomar água.",
				model: "",
				enabled: true,
				triggerType: "once" as const,
				schedule: null,
				timezone: "America/Sao_Paulo",
				lastRunAt: null,
				createdAt: new Date(0).toISOString(),
				updatedAt: new Date(0).toISOString(),
				once: { runAt: expectedRunAt },
			},
		} as never);
		const prompts: string[] = [];
		const routineEvents: { action: string; detail?: string }[] = [];
		const toolResults: { ok: boolean; summary: string }[] = [];
		const llmQueue: CompleteChatWithToolsResult[] = [
			{
				model: "test-model",
				message: {
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call-agua",
							type: "function",
							function: {
								name: "propose_routine",
								arguments: JSON.stringify({
									action: "create",
									title: "Tomar água",
									detail: "Lembra de tomar água.",
									trigger_type: "once",
									in_minutes: 30,
								}),
							},
						},
					],
				},
			},
			{ model: "test-model", message: { role: "assistant", content: "Pronto, te aviso em 30 minutos." } },
		];
		await runComputerUse({
			manager: {} as unknown as SandboxManager,
			getSessionId: async () => "session-agua",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "me lembra daqui 30 minutos de tomar água" }],
			runId: "run-agua",
			conversationId: "conv-agua",
			botId: "bot-1",
			maxSteps: 4,
			onEvent: (event) => {
				if (event.type === "routine") routineEvents.push({ action: event.action, detail: event.detail });
				if (event.type === "tool_result" && event.name === "propose_routine") toolResults.push({ ok: event.ok, summary: event.summary });
			},
			streamChat: async (params) => {
				prompts.push(params.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
				const next = llmQueue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});

		expect(prompts[0]).toContain("Now is 2026-10-25 14:32 (domingo), timezone America/Sao_Paulo");
		expect(createRoutine).toHaveBeenCalledTimes(1);
		expect(createRoutine).toHaveBeenCalledWith(
			"default",
			expect.objectContaining({ triggerType: "once", trigger: { kind: "once", runAt: expectedRunAt } }),
		);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]!.ok).toBe(true);
		expect(toolResults[0]!.summary).toContain("15:02");
		expect(routineEvents).toHaveLength(1);
		expect(routineEvents[0]!.action).toBe("created");
	});

	it("run_at e in_minutes juntos (ou nenhum) não criam nada e voltam o erro ao modelo", async () => {
		const toolResults: { ok: boolean; summary: string }[] = [];
		const call = (id: string, extra: Record<string, unknown>) => ({
			id,
			type: "function" as const,
			function: {
				name: "propose_routine",
				arguments: JSON.stringify({ action: "create", title: "X", detail: "Y", trigger_type: "once", ...extra }),
			},
		});
		const llmQueue: CompleteChatWithToolsResult[] = [
			{
				model: "test-model",
				message: {
					role: "assistant",
					content: null,
					tool_calls: [call("both", { run_at: "2026-10-26T10:00", in_minutes: 30 }), call("none", {})],
				},
			},
			{ model: "test-model", message: { role: "assistant", content: "Não consegui." } },
		];
		await runComputerUse({
			manager: {} as unknown as SandboxManager,
			getSessionId: async () => "session-agua-2",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "me lembra daqui 30 minutos de tomar água" }],
			runId: "run-agua-2",
			conversationId: "conv-agua-2",
			botId: "bot-1",
			maxSteps: 4,
			onEvent: (event) => {
				if (event.type === "tool_result" && event.name === "propose_routine") toolResults.push({ ok: event.ok, summary: event.summary });
			},
			streamChat: async () => {
				const next = llmQueue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		expect(createRoutine).not.toHaveBeenCalled();
		expect(toolResults).toHaveLength(2);
		expect(toolResults[0]!.summary).toContain("run_at OU in_minutes");
		expect(toolResults[1]!.summary).toContain("informe run_at");
	});
});

describe("SYSTEM_PROMPT: regras de lembrete e honestidade", () => {
	it("instrui lembrete 'once' por horário e não substituir pelo calendário", () => {
		expect(SYSTEM_PROMPT).toContain("Lembretes:");
		expect(SYSTEM_PROMPT).toContain("trigger_type `once`");
		expect(SYSTEM_PROMPT).toMatch(/uma chamada de propose_routine POR horário/);
		expect(SYSTEM_PROMPT).toMatch(/nunca substitui o lembrete no chat/);
	});

	it("instrui honestidade: nunca dizer que não consegue sem tentar a tool (bloco de disciplina, todo modelo)", () => {
		for (const model of ["anthropic/claude-sonnet-4.5", "deepseek/deepseek-chat"]) {
			expect(disciplineForModel(model)).toContain("Never say you cannot do something before trying the matching tool.");
			expect(disciplineForModel(model)).toContain("say so with the real error");
		}
	});

	it("política única de agir primeiro: ações reversíveis não esperam pergunta", () => {
		expect(SYSTEM_PROMPT).toMatch(/Never ask for something the user already said or a tool can find/);
		expect(SYSTEM_PROMPT).toMatch(/When you must ask: one batched round, then wait\./);
		expect(SYSTEM_PROMPT).toMatch(/Reversible writes the user asked for \(routines, reminders, skills, drafts\) show a card or result they can adjust: do them directly\./);
	});
});

/**
 * Bug original: `POST /v1/questionnaire/submit` injetava sempre a instrução
 * de onboarding, então QUALQUER resposta de questionário (mesmo no meio de
 * um pedido normal, ex.: "me lembra de dar deploy dia 03/10") virava
 * proposta de `propose_profile_update`. Este bloco cobre o gate: a tool só
 * aparece pro modelo quando onboarding não terminou, é evento de config do
 * bot, é resposta de questionário de ONBOARDING, ou o usuário pediu
 * explicitamente para mudar o bot.
 */
/** Jev mockado que só reconhece a intenção de mudar o perfil (qualquer idioma). */
function profileChangeJev(yes: boolean) {
	return {
		modes: { intent: "on" as const },
		ask: vi.fn(async ({ questions }: { questions: Record<string, unknown> }) => ({
			model: "typesafe/jev-1.13",
			answers: Object.fromEntries(Object.keys(questions).map((key) => [key, key === "profile_change" && yes ? 0.95 : 0])),
			durationMs: 1,
		})),
	};
}

describe("gate de propose_profile_update (exposição da tool)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	async function runGate(input: {
		lastUserContent: string;
		objective?: string;
		botDescription?: string | null;
		jev?: ReturnType<typeof profileChangeJev>;
	}) {
		vi.mocked(getBotProfile).mockResolvedValue(
			input.botDescription === undefined
				? null
				: {
						name: "Bot",
						snippet: "",
						description: input.botDescription,
						openRouterModel: null,
						language: "pt-BR",
					},
		);
		const seenTools: string[][] = [];
		const queue = [assistantDone()];
		await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => {
				throw new Error("nao deve criar sessao");
			},
			sandboxEnabled: false,
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: input.lastUserContent }],
			botId: "bot-1",
			conversationId: "conv-gate",
			runId: "run-gate",
			...(input.objective ? { objective: input.objective } : {}),
			...(input.jev ? { jev: input.jev } : {}),
			maxSteps: 4,
			onEvent: () => undefined,
			streamChat: async (params) => {
				seenTools.push(params.tools.map((tool) => tool.function.name));
				const next = queue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		return { seenTools };
	}

	it("NÃO expõe quando o onboarding já terminou e o pedido é comum", async () => {
		const { seenTools } = await runGate({
			lastUserContent: "me lembra de dar deploy dia 03/10 pelo chat",
			botDescription: "Bot de suporte já configurado",
		});
		expect(seenTools[0]).not.toContain("propose_profile_update");
	});

	it("expõe quando o bot ainda não tem briefing (onboarding em curso)", async () => {
		const { seenTools } = await runGate({
			lastUserContent: "oi",
			botDescription: null,
		});
		expect(seenTools[0]).toContain("propose_profile_update");
	});

	it("expõe no evento bot-created mesmo com onboarding \"terminado\"", async () => {
		const { seenTools } = await runGate({
			lastUserContent: JSON.stringify({ event: "bot-created" }),
			objective: "[bot-created] Perguntas de onboarding do Bot",
			botDescription: "já tem descrição",
		});
		expect(seenTools[0]).toContain("propose_profile_update");
	});

	it("config-closed não é mais evento de config: fechar a Config não abre o perfil ao agente", async () => {
		const { seenTools } = await runGate({
			lastUserContent: JSON.stringify({ event: "config-closed" }),
			objective: "Config atualizada: description",
			botDescription: "já tem descrição",
		});
		expect(seenTools[0]).not.toContain("propose_profile_update");
	});

	it("expõe quando o Jev reconhece o pedido explícito de mudar o bot", async () => {
		const { seenTools } = await runGate({
			lastUserContent: "cámbiate el nombre a Jarvis",
			botDescription: "já configurado",
			jev: profileChangeJev(true),
		});
		expect(seenTools[0]).toContain("propose_profile_update");
	});

	it("Jev desligado: pedido de mudar o perfil NÃO abre a tool fora do onboarding (seguro por padrão)", async () => {
		const { seenTools } = await runGate({
			lastUserContent: "mude seu nome para Jarvis",
			botDescription: "já configurado",
		});
		expect(seenTools[0]).not.toContain("propose_profile_update");
	});

	it("Jev diz não: mensagem comum não abre a tool", async () => {
		const { seenTools } = await runGate({
			lastUserContent: "mude seu nome para Jarvis",
			botDescription: "já configurado",
			jev: profileChangeJev(false),
		});
		expect(seenTools[0]).not.toContain("propose_profile_update");
	});

	it("NÃO expõe em resposta de questionário de TAREFA (o caso do bug)", async () => {
		const { seenTools } = await runGate({
			lastUserContent: JSON.stringify({
				questionnaireId: "q-1",
				event: "questionnaire-answered",
				answers: { canal: "chat" },
				submittedAt: new Date(0).toISOString(),
				purpose: "task",
			}),
			botDescription: "já configurado",
		});
		expect(seenTools[0]).not.toContain("propose_profile_update");
	});

	it("expõe em resposta de questionário de ONBOARDING", async () => {
		const { seenTools } = await runGate({
			lastUserContent: JSON.stringify({
				questionnaireId: "q-1",
				event: "questionnaire-answered",
				answers: { direction: "suporte" },
				submittedAt: new Date(0).toISOString(),
				purpose: "onboarding",
			}),
			botDescription: "já configurado",
		});
		expect(seenTools[0]).toContain("propose_profile_update");
	});
});

describe("propose_routine: sem guard por frase, a descrição diz quando não usar", () => {
	it("a descrição proíbe criar rotina só por agradecimento/elogio e o executor não bloqueia por texto", async () => {
		let description = "";
		const toolResults: Array<{ name: string; ok: boolean; summary: string }> = [];
		const queue = [
			toolCall("c1", "propose_routine", { action: "create", title: "Teste", detail: "Avisar", trigger_type: "interval", every_minutes: 60 }),
			assistantDone(),
		];
		await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => {
				throw new Error("nao deve criar sessao");
			},
			sandboxEnabled: false,
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "ficou ótimo, obrigado!" }],
			botId: "bot-1",
			conversationId: "conv-ack",
			runId: "run-ack",
			maxSteps: 4,
			onEvent: (event) => {
				if (event.type === "tool_result") toolResults.push(event);
			},
			streamChat: async (params) => {
				description ||= params.tools.find((t) => t.function.name === "propose_routine")?.function.description ?? "";
				const next = queue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		expect(description).toMatch(/Do not use when the user only thanks, praises or acknowledges/);
		expect(toolResults[0]?.summary ?? "").not.toMatch(/elogiou/);
	});
});

describe("executeProposeProfileUpdate (defesa no executor)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("recusa sem emitir card fora do onboarding/evento/pedido explícito", async () => {
		vi.mocked(getBotProfile).mockResolvedValue({
			name: "Bot",
			snippet: "resumo",
			description: "Bot de suporte já configurado",
			openRouterModel: null,
			language: "pt-BR",
		});
		const toolResults: Array<{ name: string; ok: boolean; summary: string }> = [];
		const queue = [
			toolCall("c1", "propose_profile_update", { name: "Novo Nome" }),
			assistantDone(),
		];
		await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => {
				throw new Error("nao deve criar sessao");
			},
			sandboxEnabled: false,
			model: "test-model",
			apiKey: "test",
			messages: [
				{ role: "user", content: "me lembra de dar deploy dia 03/10 pelo chat" },
			],
			botId: "bot-1",
			conversationId: "conv-exec",
			runId: "run-exec",
			maxSteps: 4,
			onEvent: (event) => {
				if (event.type === "tool_result") toolResults.push(event);
			},
			streamChat: async () => {
				const next = queue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		expect(toolResults[0]).toMatchObject({
			name: "propose_profile_update",
			ok: true,
			summary: "Perfil não alterado: só no onboarding ou quando o usuário pedir.",
		});
		expect(
			vi.mocked(persistConversationCardFromEvent).mock.calls.some(
				([, event]) => (event as { type?: string })?.type === "bot-profile",
			),
		).toBe(false);
	});

	it("deixa passar (emite card) quando o usuário pede explicitamente", async () => {
		vi.mocked(getBotProfile).mockResolvedValue({
			name: "Bot",
			snippet: "resumo",
			description: "Bot de suporte já configurado",
			openRouterModel: null,
			language: "pt-BR",
		});
		const toolResults: Array<{ name: string; ok: boolean; summary: string }> = [];
		const queue = [
			toolCall("c1", "propose_profile_update", { name: "Jarvis" }),
			assistantDone(),
		];
		await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => {
				throw new Error("nao deve criar sessao");
			},
			sandboxEnabled: false,
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "mude seu nome para Jarvis" }],
			jev: profileChangeJev(true),
			botId: "bot-1",
			conversationId: "conv-exec-2",
			runId: "run-exec-2",
			// Sempre perguntar: o card fica pendente (Aplicar/Descartar).
			autonomy: { level: "always_ask", exceptions: [] },
			maxSteps: 4,
			onEvent: (event) => {
				if (event.type === "tool_result") toolResults.push(event);
			},
			streamChat: async () => {
				const next = queue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		expect(toolResults[0]?.summary).toMatch(/confirmação humana/);
		expect(
			vi.mocked(persistConversationCardFromEvent).mock.calls.some(
				([, event]) => (event as { type?: string })?.type === "bot-profile",
			),
		).toBe(true);
	});
});

/**
 * `propose_questionnaire` grava `purpose` (default "task", forçado
 * "onboarding" no evento de config do bot) e a ORIGINAL REQUEST
 * (`ctx.objective`) no card — é o que a rota de submit usa pra escolher a
 * instrução certa (`questionnaireAnswerInstruction`).
 */
describe("propose_questionnaire: purpose e original request no card", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	function findQuestionnaireCard() {
		return vi
			.mocked(persistConversationCardFromEvent)
			.mock.calls.find(
				([, event]) => (event as { type?: string })?.type === "questionnaire",
			)?.[1] as { purpose?: string; originalRequest?: string } | undefined;
	}

	it("força purpose=onboarding no evento bot-created mesmo sem o modelo informar purpose", async () => {
		const queue = [
			toolCall("c1", "propose_questionnaire", {
				title: "Qual o foco do bot?",
				items: [
					{
						name: "direction",
						prompt: "Qual é o foco do bot?",
						choices: [{ value: "suporte" }],
					},
				],
			}),
			assistantDone(),
		];
		await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => {
				throw new Error("nao deve criar sessao");
			},
			sandboxEnabled: false,
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: JSON.stringify({ event: "bot-created" }) }],
			botId: "bot-1",
			conversationId: "conv-q1",
			runId: "run-q1",
			objective: "[bot-created] Perguntas de onboarding do Bot",
			maxSteps: 4,
			onEvent: () => undefined,
			streamChat: async () => {
				const next = queue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		expect(findQuestionnaireCard()?.purpose).toBe("onboarding");
	});

	it("purpose task (padrão) guarda a original request (ctx.objective) no card", async () => {
		const queue = [
			toolCall("c1", "propose_questionnaire", {
				title: "Onde te aviso?",
				items: [
					{
						name: "canal",
						prompt: "Onde te aviso do deploy?",
						choices: [{ value: "chat" }, { value: "email" }],
					},
				],
			}),
			assistantDone(),
		];
		await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => {
				throw new Error("nao deve criar sessao");
			},
			sandboxEnabled: false,
			model: "test-model",
			apiKey: "test",
			messages: [
				{ role: "user", content: "me lembra de dar deploy dia 03/10 pelo chat" },
			],
			botId: "bot-1",
			conversationId: "conv-q2",
			runId: "run-q2",
			objective: "me lembra de dar deploy dia 03/10 pelo chat",
			// O teste é do conteúdo do card: com a economia o questionário só entra por intenção (onboarding, novo agente).
			contextEconomy: false,
			maxSteps: 4,
			onEvent: () => undefined,
			streamChat: async () => {
				const next = queue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		const card = findQuestionnaireCard();
		expect(card?.purpose).toBe("task");
		expect(card?.originalRequest).toBe(
			"me lembra de dar deploy dia 03/10 pelo chat",
		);
	});
});

describe("F4 questionário tolerante a formato", () => {
	it("items como string JSON", () => {
		const proposal = parseProposeQuestionnaireArgs({
			title: "Foco?",
			items: JSON.stringify([
				{ name: "direction", prompt: "Qual o foco?", choices: [{ value: "suporte" }] },
			]),
		});
		expect(proposal.items).toHaveLength(1);
		expect(proposal.items[0]?.name).toBe("direction");
	});

	it("choices string[] viram {value, label}", () => {
		const proposal = parseProposeQuestionnaireArgs({
			title: "Canal?",
			items: [
				{ name: "canal", prompt: "Onde aviso?", choices: ["chat", "email"] },
			],
		});
		expect(proposal.items[0]?.choices).toEqual([
			{ value: "chat", label: "chat" },
			{ value: "email", label: "email" },
		]);
	});

	it("choices como string JSON", () => {
		const proposal = parseProposeQuestionnaireArgs({
			title: "Canal?",
			items: [
				{
					name: "canal",
					prompt: "Onde aviso?",
					choices: JSON.stringify([{ value: "chat" }]),
				},
			],
		});
		expect(proposal.items[0]?.choices).toEqual([{ value: "chat" }]);
	});

	it("JSON inválido vira tool_result de erro com exemplo, sem abortar", async () => {
		const toolResults: Array<{ ok: boolean; summary: string }> = [];
		const queue: CompleteChatWithToolsResult[] = [
			{
				model: "test-model",
				message: {
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "bad1",
							type: "function",
							function: { name: "propose_questionnaire", arguments: "{não é json" },
						},
					],
				},
			},
			assistantDone(),
		];
		const result = await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => {
				throw new Error("nao deve criar sessao");
			},
			sandboxEnabled: false,
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "pergunta algo" }],
			botId: "bot-1",
			conversationId: "conv-qbad",
			runId: "run-qbad",
			maxSteps: 4,
			onEvent: (event) => {
				if (event.type === "tool_result") toolResults.push(event);
			},
			streamChat: async () => {
				const next = queue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		expect(result.text).toContain("Pronto");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]?.ok).toBe(false);
		expect(toolResults[0]?.summary).toMatch(/argumentos inválidos \(JSON\)/);
		expect(toolResults[0]?.summary).toMatch(/Exemplo:/);
	});
});

describe("CONNECTOR_ARGS_GUIDANCE", () => {
	it("orienta paginar ou estreitar antes de concluir sobre listas cortadas", () => {
		expect(CONNECTOR_ARGS_GUIDANCE).toContain(
			"When a list tool supports pagination and a result looks truncated, or the user says items are missing, fetch further pages or narrow the query before concluding; never claim you checked everything when you saw only part of it.",
		);
	});
});
