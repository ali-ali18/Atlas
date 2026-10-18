import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsResult, LlmMessage } from "@workspace/llm";
import type { FinishReason } from "@workspace/shared";
import { BudgetExhaustedError, classifyRunError } from "./errors.js";
import { budgetStopFallbackText, DECISION_TIMEOUT_MESSAGE, runComputerUse, truncatedToolCallMessage } from "./computer-use.js";
import { resetStagedFilesForTest } from "./tools/create-file.js";
import { wrapUpWindowMs } from "./budget.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

const MIN = 60_000;
const text = (content: string, finishReason?: FinishReason): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content },
	...(finishReason ? { finishReason } : {}),
});
const toolReply = (name: string, args: string, finishReason?: FinishReason, id = "call-1"): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] },
	...(finishReason ? { finishReason } : {}),
});
const base = {
	manager: {} as SandboxManager,
	getSessionId: async () => "unused",
	sandboxEnabled: false,
	apiKey: "test",
	model: "m",
	runId: "run-closing",
	userId: "user-a",
	origin: "chat",
	messages: [{ role: "user" as const, content: "Faça o relatório." }],
	onEvent: () => undefined,
};

beforeEach(() => resetStagedFilesForTest());

describe("A7: teto de tempo ainda entrega um resumo", () => {
	it("prazo já esgotado: o resumo final sai com sinal próprio e a mensagem sugere continuar", async () => {
		const calls: Array<{ toolChoice?: string; aborted: boolean; deadlineAtMs?: number; messages: LlmMessage[] }> = [];
		const error = await runComputerUse({
			...base,
			restoredCheckpoint: { version: 1, messages: [], nextStepIndex: 0, activeElapsedMs: 31 * MIN },
			runStartedAt: Date.now() - 4 * 60 * MIN,
			streamChat: (async (params: { toolChoice?: string; signal?: AbortSignal; deadlineAtMs?: number; messages: LlmMessage[] }) => {
				calls.push({ toolChoice: params.toolChoice, aborted: params.signal?.aborted === true, deadlineAtMs: params.deadlineAtMs, messages: params.messages });
				return text("Feito: coleta dos dados. Falta: gráficos. Responda continuar.");
			}) as never,
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(BudgetExhaustedError);
		expect(classifyRunError(error)).toBe("budget_exhausted");
		expect((error as BudgetExhaustedError).finalText).toContain("Falta: gráficos");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ toolChoice: "none", aborted: false, deadlineAtMs: undefined });
		const prompt = String(calls[0]!.messages.at(-1)?.content);
		expect(prompt).toContain("continuar");
	});

	it("o run para de iniciar passos na janela de fechamento, antes do prazo", async () => {
		const wall = 10 * MIN;
		const window = wrapUpWindowMs(wall);
		expect(window).toBeGreaterThan(0);
		expect(window).toBeLessThanOrEqual(75_000);
		let calls = 0;
		const error = await runComputerUse({
			...base,
			budget: { maxWallMs: wall },
			restoredCheckpoint: { version: 1, messages: [], nextStepIndex: 0, activeElapsedMs: wall - window / 2 },
			streamChat: (async () => {
				calls += 1;
				return text("Resumo: parei no tempo. Falta o restante.");
			}) as never,
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(BudgetExhaustedError);
		// Uma única chamada: o resumo final (nenhum passo normal começou).
		expect(calls).toBe(1);
		expect((error as BudgetExhaustedError).finalText).toContain("Resumo");
	});

	it("sem resumo do modelo ainda há texto pt-BR com o caminho de continuar", async () => {
		const error = await runComputerUse({
			...base,
			restoredCheckpoint: { version: 1, messages: [], nextStepIndex: 0, activeElapsedMs: 31 * MIN },
			streamChat: (async () => {
				throw new Error("provider down");
			}) as never,
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(BudgetExhaustedError);
		const final = (error as BudgetExhaustedError).finalText!;
		expect(final).toBe(budgetStopFallbackText((error as Error).message));
		expect(final).toMatch(/continuar/);
		expect(final).toMatch(/tempo máximo do run esgotado/);
	});
});

describe("A8: arquivo grande", () => {
	const fileDeps = () => {
		const persisted: Array<{ bytes: Uint8Array; meta?: Record<string, unknown> }> = [];
		return {
			persisted,
			deps: {
				persist: vi.fn(async (input: { bytes: Uint8Array; meta?: Record<string, unknown>; kind: string; mime: string }) => {
					persisted.push({ bytes: input.bytes, meta: input.meta });
					return { id: `art-${persisted.length}`, kind: input.kind, meta: { ...(input.meta ?? {}), mime: input.mime, size: input.bytes.byteLength }, runId: "run-closing", conversationId: null, createdAt: new Date() };
				}),
				nextVersion: vi.fn(async () => 1),
				countRunFiles: vi.fn(async () => 0),
			},
		};
	};

	it("args de create_file cortados (finish_reason length): o modelo recebe a orientação de partes e o arquivo final tem todas as partes", async () => {
		const { persisted, deps } = fileDeps();
		const requests: LlmMessage[][] = [];
		const script = [
			// 1) cortado pelo limite de saída: JSON incompleto.
			toolReply("create_file", '{"filename":"grande.md","content":"# Título\\n' + "x".repeat(50), "length", "c1"),
			// 2) em partes.
			toolReply("create_file", JSON.stringify({ filename: "grande.md", part: 1, more: true, content: "# Parte 1\n" }), "tool_calls", "c2"),
			toolReply("create_file", JSON.stringify({ filename: "grande.md", part: 2, more: true, content: "Parte 2\n" }), "tool_calls", "c3"),
			toolReply("create_file", JSON.stringify({ filename: "grande.md", part: 3, more: false, content: "Parte 3\n" }), "tool_calls", "c4"),
			text("Arquivo pronto.", "stop"),
		];
		let index = 0;
		const events: Array<{ type: string }> = [];
		const result = await runComputerUse({
			...base,
			createFileDeps: deps as never,
			onEvent: (event) => { events.push(event); },
			streamChat: (async (params: { messages: LlmMessage[] }) => {
				requests.push(JSON.parse(JSON.stringify(params.messages)) as LlmMessage[]);
				return script[Math.min(index++, script.length - 1)]!;
			}) as never,
		});
		expect(result.text).toContain("Arquivo pronto");
		// O resultado da chamada cortada orienta a escrever em partes (não é "argumentos inválidos").
		const toolMessages = requests[1]!.filter((m) => m.role === "tool").map((m) => String(m.content));
		expect(toolMessages.join("\n")).toContain("cut off by the output limit");
		expect(toolMessages.join("\n")).toContain("part=1");
		expect(toolMessages.join("\n")).not.toContain("argumentos inválidos");
		// Um único arquivo, com as três partes na ordem.
		expect(persisted).toHaveLength(1);
		expect(new TextDecoder().decode(persisted[0]!.bytes)).toBe("# Parte 1\nParte 2\nParte 3\n");
		expect(events.filter((e) => e.type === "file")).toHaveLength(1);
	});

	it("timeout da decisão: repete o passo uma vez com orientação; segundo timeout falha clara e permanente (sem retry da fila)", async () => {
		const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
		const requests: LlmMessage[][] = [];
		let index = 0;
		const outcome = await runComputerUse({
			...base,
			streamChat: (async (params: { messages: LlmMessage[] }) => {
				requests.push(JSON.parse(JSON.stringify(params.messages)) as LlmMessage[]);
				index += 1;
				throw timeout();
			}) as never,
		}).catch((e: unknown) => e);
		expect(index).toBe(2);
		expect(requests[1]!.some((m) => m.role === "system" && String(m.content).includes("timed out"))).toBe(true);
		expect(classifyRunError(outcome)).toBe("permanent");
		expect((outcome as Error).message).toBe(DECISION_TIMEOUT_MESSAGE);
	});

	it("timeout seguido de sucesso: o run conclui normalmente", async () => {
		let index = 0;
		const result = await runComputerUse({
			...base,
			streamChat: (async () => {
				index += 1;
				if (index === 1) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
				return text("Pronto.", "stop");
			}) as never,
		});
		expect(result.text).toBe("Pronto.");
	});

	it("mensagem de truncamento de create_file explica as partes", () => {
		const message = truncatedToolCallMessage("create_file", 1234);
		expect(message).toMatch(/part=1/);
		expect(message).toMatch(/more=false/);
		expect(truncatedToolCallMessage("web_search", 10)).toMatch(/shorter/);
	});
});
