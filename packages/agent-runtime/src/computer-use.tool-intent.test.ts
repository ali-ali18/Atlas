import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsResult, LlmToolCall, StreamChatWithToolsHandlers } from "@workspace/llm";
import type { ComputerUseEvent } from "@workspace/shared";
import { runComputerUse } from "./computer-use.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

/** `tool_intent`: a UI sabe o nome da tool antes dos argumentos. LLM mockado; o mock avisa como o stream real. */
const done: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "Pronto." } };
const call = (name: string, args: Record<string, unknown>, id = "c1"): LlmToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const turn = (...calls: LlmToolCall[]): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: null, tool_calls: calls } });

async function replay(input: { script: CompleteChatWithToolsResult[]; origin?: "chat" | "routine"; announce?: boolean; announceAs?: (call: LlmToolCall) => string }) {
	const events: ComputerUseEvent[] = [];
	const script = [...input.script];
	const manager = { execNavigate: vi.fn(async () => ({ url: "https://loja.exemplo.com.br", title: "Loja" })) } as unknown as SandboxManager;
	await runComputerUse({
		manager,
		getSessionId: async () => "session-1",
		apiKey: "test",
		model: "m",
		runId: "run-intent",
		userId: "user-a",
		botId: "bot-a",
		origin: input.origin ?? "chat",
		contextEconomy: true,
		messages: [{ role: "user", content: "abra o site loja.exemplo.com.br" }],
		maxSteps: 6,
		onEvent: (event) => void events.push(event),
		streamChat: async (_params, handlers?: StreamChatWithToolsHandlers) => {
			const reply = script.shift() ?? done;
			if (input.announce !== false) {
				(reply.message.tool_calls ?? []).forEach((c, index) => handlers?.onToolIntent?.({ index, id: c.id, name: input.announceAs?.(c) ?? c.function.name }));
			}
			return reply;
		},
	});
	return events;
}

beforeEach(() => vi.clearAllMocks());

describe("tool_intent", () => {
	it("sai uma vez por chamada, antes do tool_call, só com nome e id", async () => {
		const events = await replay({ script: [turn(call("navigate", { url: "https://loja.exemplo.com.br/?token=segredo-123" })), done] });
		const types = events.map((e) => e.type);
		expect(types.filter((t) => t === "tool_intent")).toHaveLength(1);
		expect(types.indexOf("tool_intent")).toBeLessThan(types.indexOf("tool_call"));
		const intent = events.find((e) => e.type === "tool_intent");
		expect(intent).toEqual({ type: "tool_intent", name: "navigate" });
		expect(JSON.stringify(intent)).not.toContain("segredo");
	});

	it("sem aviso do stream (provedor sem suporte): o fluxo é o de sempre, sem tool_intent", async () => {
		const events = await replay({ announce: false, script: [turn(call("navigate", { url: "https://loja.exemplo.com.br" })), done] });
		expect(events.some((e) => e.type === "tool_intent")).toBe(false);
		expect(events.some((e) => e.type === "tool_call")).toBe(true);
		expect(events.some((e) => e.type === "tool_result")).toBe(true);
	});

	it("tool que o run não expõe não gera intent (como o tool_call também não seria legítimo)", async () => {
		const events = await replay({ announceAs: () => "ferramenta_inexistente", script: [turn(call("navigate", { url: "https://loja.exemplo.com.br" })), done] });
		expect(events.some((e) => e.type === "tool_intent")).toBe(false);
	});

	it("rotina (sem front ao vivo) não emite", async () => {
		const events = await replay({ origin: "routine", script: [turn(call("navigate", { url: "https://loja.exemplo.com.br" })), done] });
		expect(events.some((e) => e.type === "tool_intent")).toBe(false);
	});

	it("o mesmo index avisado duas vezes (nova tentativa do provedor) vira um evento só", async () => {
		const events: ComputerUseEvent[] = [];
		const script = [turn(call("navigate", { url: "https://loja.exemplo.com.br" })), done];
		await runComputerUse({
			manager: { execNavigate: vi.fn(async () => ({ url: "https://x.test", title: "x" })) } as unknown as SandboxManager,
			getSessionId: async () => "session-1",
			apiKey: "test",
			model: "m",
			runId: "run-intent-2",
			userId: "user-a",
			botId: "bot-a",
			origin: "chat",
			contextEconomy: true,
			messages: [{ role: "user", content: "abra o site loja.exemplo.com.br" }],
			maxSteps: 6,
			onEvent: (event) => void events.push(event),
			streamChat: async (_p, handlers) => {
				const reply = script.shift() ?? done;
				for (const c of reply.message.tool_calls ?? []) {
					handlers?.onToolIntent?.({ index: 0, id: c.id, name: c.function.name });
					handlers?.onToolIntent?.({ index: 0, id: c.id, name: c.function.name });
				}
				return reply;
			},
		});
		expect(events.filter((e) => e.type === "tool_intent")).toHaveLength(1);
	});

	it("nova tentativa do provedor com outra tool no mesmo index: as duas são avisadas", async () => {
		const events: ComputerUseEvent[] = [];
		const script = [turn(call("screenshot", {})), done];
		await runComputerUse({
			manager: { execScreenshot: vi.fn(async () => ({ base64: "", width: 1, height: 1 })) } as unknown as SandboxManager,
			getSessionId: async () => "session-1",
			apiKey: "test",
			model: "m",
			runId: "run-intent-3",
			userId: "user-a",
			botId: "bot-a",
			origin: "chat",
			contextEconomy: true,
			messages: [{ role: "user", content: "abra o site loja.exemplo.com.br" }],
			maxSteps: 6,
			onEvent: (event) => void events.push(event),
			streamChat: async (_p, handlers) => {
				const reply = script.shift() ?? done;
				if (reply.message.tool_calls) {
					// tentativa 1 anunciou "navigate" no index 0 e caiu; a tentativa 2 traz outra tool no mesmo index.
					handlers?.onToolIntent?.({ index: 0, name: "navigate" });
					handlers?.onToolIntent?.({ index: 0, name: "screenshot" });
				}
				return reply;
			},
		});
		expect(events.filter((e) => e.type === "tool_intent").map((e) => (e as { name: string }).name)).toEqual(["navigate", "screenshot"]);
	});

});
