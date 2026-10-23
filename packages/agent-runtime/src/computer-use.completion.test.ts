import { describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsResult, LlmMessage, LlmToolCall } from "@workspace/llm";
import type { AgentRunCheckpoint, FinishReason } from "@workspace/shared";
import { AgentRunLoopDetectedError } from "./errors.js";
import { runComputerUse } from "./computer-use.js";
import { FILE_PROMISE_SYSTEM } from "./execution/delivery-correction.js";
import { MISSING_ARTIFACT_NOTE, TRUNCATED_REPLY_NOTE } from "./execution/task-state.js";
import { jevSaying, WANTS_FILE_JEV } from "./jev/test-support.js";
import { buildMcpToolset } from "./mcp/registry.js";
import { namespaceToolCallId } from "./context/transcript.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

const reply = (content: string, finishReason?: FinishReason): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content },
	...(finishReason ? { finishReason } : {}),
});
const base = {
	manager: {} as SandboxManager,
	getSessionId: async () => "unused",
	sandboxEnabled: false,
	apiKey: "test",
	model: "m",
	runId: "run-l18",
	userId: "user-a",
	origin: "chat",
	messages: [{ role: "user" as const, content: "Please help me." }],
};

async function run(script: CompleteChatWithToolsResult[], extra: Record<string, unknown> = {}, promisesFile?: boolean) {
	const requests: LlmMessage[][] = [];
	let promiseChecks = 0;
	let checkpoint: AgentRunCheckpoint | undefined;
	let index = 0;
	const outcome = await runComputerUse({
		...base,
		onEvent: () => undefined,
		onCheckpoint: async (value) => {
			checkpoint = value;
		},
		streamChat: async (params) => {
			// Chamada barata "a resposta promete arquivo?": não faz parte do roteiro do run.
			if (String(params.messages[0]?.content).startsWith(FILE_PROMISE_SYSTEM)) {
				promiseChecks += 1;
				return reply(JSON.stringify({ promisesFile: promisesFile === true }));
			}
			requests.push(JSON.parse(JSON.stringify(params.messages)) as LlmMessage[]);
			return script[Math.min(index++, script.length - 1)]!;
		},
		...extra,
	}).then(
		(result) => ({ result, error: undefined }),
		(error: unknown) => ({ result: undefined, error }),
	);
	const systemTexts = (request: LlmMessage[]) => request.filter((m) => m.role === "system").map((m) => String(m.content));
	return { ...outcome, requests, checkpoint, systemTexts, promiseChecks: () => promiseChecks };
}

const askPdf = { messages: [{ role: "user" as const, content: "Fais-moi un rapport en PDF" }], jev: WANTS_FILE_JEV };

describe("L18: arquivo pedido (Jev) sem artefato", () => {
	it("pedido reconhecido pelo Jev em qualquer idioma: resposta só em texto não conclui; follow-up honesto conclui", async () => {
		const { result, requests, systemTexts, checkpoint, promiseChecks } = await run(
			[
				reply("Je vais créer le PDF maintenant.", "stop"),
				reply("I could not produce the file; here is the summary instead.", "stop"),
			],
			askPdf,
			false,
		);
		expect(requests).toHaveLength(2);
		expect(systemTexts(requests[1]!)).toContain(MISSING_ARTIFACT_NOTE);
		expect(result?.text).toContain("could not produce the file");
		expect(checkpoint?.taskState?.criteria).toEqual([]);
		expect(checkpoint?.taskState?.blockers.length).toBe(1);
		// No chat nenhum juiz confere a resposta depois do aviso: ela sai como está (o usuário já viu o rascunho).
		expect(promiseChecks()).toBe(0);
	});

	it("no chat, prometer de novo depois do aviso não derruba o run: a resposta sai como está, sem segunda revisão", async () => {
		const events: Array<{ type: string }> = [];
		const { result, error, requests, promiseChecks } = await run(
			[reply("Vou gerar o PDF agora.", "stop"), reply("Vou gerar o PDF agora, um momento.", "stop")],
			{ ...askPdf, onEvent: (event: { type: string }) => { events.push(event); } },
			true,
		);
		expect(error).toBeUndefined();
		expect(requests).toHaveLength(2);
		expect(result?.text).toContain("um momento");
		expect(promiseChecks()).toBe(0);
		expect(events.filter((event) => event.type === "assistant_discard")).toHaveLength(1);
	});

	it("run sem o usuário no chat (conversa entre bots): prometer de novo depois do aviso (veredito do modelo barato) encerra o run como não concluído", async () => {
		const { error, checkpoint } = await run(
			[
				reply("Vou gerar o PDF agora.", "stop"),
				reply("Vou gerar o PDF agora, um momento.", "stop"),
				reply("Summary of what happened.", "stop"),
			],
			{ ...askPdf, origin: "bot" },
			true,
		);
		expect(error).toBeInstanceOf(AgentRunLoopDetectedError);
		expect((error as Error).message).toContain("nenhum arquivo foi criado");
		expect(checkpoint?.taskState?.criteria[0]).toMatchObject({ id: "artifact:file", status: "open" });
	});

	it("sem Jev (off/falha) não há expectativa de arquivo: nenhum aviso e nenhuma chamada extra", async () => {
		const { result, requests, promiseChecks } = await run([reply("I'll create the PDF report now.", "stop")], {
			messages: askPdf.messages,
		});
		expect(requests).toHaveLength(1);
		expect(result?.text).toContain("create the PDF");
		expect(promiseChecks()).toBe(0);
	});

	it("o Jev diz que não é pedido de arquivo: a resposta conclui numa chamada, mesmo falando de PDF", async () => {
		const { result, requests, promiseChecks } = await run(
			[reply("A PDF is a portable document format. I'll create one if you want.", "stop")],
			{ messages: [{ role: "user", content: "O que é um PDF?" }], jev: jevSaying({}) },
		);
		expect(requests).toHaveLength(1);
		expect(result?.text).toContain("portable document format");
		expect(promiseChecks()).toBe(0);
	});

	it("without a create tool there is nothing to enforce", async () => {
		const { result, requests } = await run([reply("I'll create the file for you.", "stop")], {
			...askPdf,
			toolFilter: (name: string) => name !== "create_file",
		});
		expect(requests).toHaveLength(1);
		expect(result?.text).toContain("create the file");
	});
});

describe("L18: finish_reason", () => {
	it("a reply cut by the output limit is continued once in the same bubble: the first part does not vanish", async () => {
		const events: Array<{ type: string; id?: string }> = [];
		const { result, requests, systemTexts } = await run(
			[reply("The first half of a long ans", "length"), reply("wer, and the second half.", "stop")],
			{
				onEvent: (event: { type: string; id?: string }) => {
					events.push(event);
				},
			},
		);
		expect(requests).toHaveLength(2);
		expect(systemTexts(requests[1]!)).toContain(TRUNCATED_REPLY_NOTE);
		// a resposta gravada é a parte exibida + a continuação, no mesmo balão (nenhum descarte)
		expect(result?.text).toBe("The first half of a long answer, and the second half.");
		expect(events.some((event) => event.type === "assistant_discard")).toBe(false);
	});

	it("still cut after the retry -> not completed", async () => {
		const { error } = await run([reply("Cut one", "length"), reply("Cut two", "length"), reply("Summary.", "stop")]);
		expect(error).toBeInstanceOf(AgentRunLoopDetectedError);
		expect((error as Error).message).toContain("cortada");
	});

	it("a stream that ended without finish_reason is retried once, then completes and records the reason", async () => {
		const { result, requests } = await run([reply("Half an answ", "incomplete"), reply("Whole answer.", "stop")]);
		expect(requests).toHaveLength(2);
		expect(result?.text).toBe("Whole answer.");
		const steps: Array<{ type: string; outputJson?: unknown }> = [];
		const again = await run([reply("Half an answ", "incomplete"), reply("Complete enough.", "incomplete")], {
			onStep: async (step: { type: string; outputJson?: unknown }) => {
				steps.push(step);
			},
		});
		expect(again.error).toBeUndefined();
		expect(again.result?.text).toBe("Complete enough.");
		expect(again.requests).toHaveLength(2);
		const modelSteps = steps.filter((step) => step.type === "model");
		expect((modelSteps.at(-1)?.outputJson as { finishReason?: string }).finishReason).toBe("incomplete");
	});

	it("a refusal is a final answer, and sources that do not report a reason stay normal", async () => {
		const refusal = await run([reply("I can't help with that.", "content_filter")]);
		expect(refusal.requests).toHaveLength(1);
		expect(refusal.result?.text).toBe("I can't help with that.");
		const legacy = await run([reply("Plain answer.")]);
		expect(legacy.requests).toHaveLength(1);
	});
});

describe("replay: mocked LLM and connector, write then truncated final answer", () => {
	const autonomy = { level: "autonomous" as const, exceptions: [] };
	const toolset = buildMcpToolset(
		[
			{
				id: "conn-a",
				slug: "data",
				name: "Data",
				disabledTools: [],
				tools: [{ name: "update", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false, destructiveHint: false } }],
			},
		],
		{ autonomy },
	);

	it("the write runs once, the cut final answer is retried, and the task state survives in the checkpoint", async () => {
		const connector = vi.fn(async () => ({ ok: true, text: "updated", truncated: false }));
		const writeCall: LlmToolCall = { id: "w1", type: "function", function: { name: "mcp__data__update", arguments: "{}" } };
		const { result, checkpoint } = await run(
			[
				{ model: "m", message: { role: "assistant", content: null, tool_calls: [writeCall] }, finishReason: "tool_calls" },
				reply("Updated, and the details are", "length"),
				reply("Updated; the record now reflects the change.", "stop"),
			],
			{ autonomy, mcp: { toolset, call: connector } },
		);
		expect(connector).toHaveBeenCalledTimes(1);
		expect(result?.text).toContain("reflects the change");
		expect(checkpoint?.executionLedger?.results?.[namespaceToolCallId("w1", "run-l18")]).toEqual({ status: "ok", effect: "applied" });
		expect(checkpoint?.executionLedger?.effects?.[0]).toMatchObject({ tool: "mcp__data__update", state: "ok" });
		expect(checkpoint?.capabilities?.tools).toContain("mcp__data__update");
		expect(checkpoint?.taskState?.phase).toBe("done");
	});
});
