/**
 * Harness v3, PR6: as 4 tools do navegador no laço do v3 (LLM roteirizado, VM falsa). Prova que o laço executa o handler
 * do v3 (e não o `browser_act` do registro global do v1/v2), que o contrato SSE não muda (mesmos eventos `tool_call` e
 * `tool_result`, só nomes de tool) e que o catálogo do v3 com VM traz o navegador novo e não o antigo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTool, CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { parseSseBlock, type ComputerUseEvent, type EffectiveAutonomy } from "@workspace/shared";
import type { ComputerUseParams } from "../run-types.js";
import { runEngineV3 } from "./loop.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => ({ name: "Cookie", description: "Assistente.", language: "pt-BR" })),
	searchMemoryEntries: vi.fn(async () => []),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	upsertTaskListCard: vi.fn(async () => undefined),
	getConversationUntrustedAt: vi.fn(async () => null),
	markConversationUntrusted: vi.fn(async () => undefined),
	markMcpTaskGrantsUntrusted: vi.fn(async () => undefined),
	saveSkillPendingIntent: vi.fn(async () => undefined),
	listSkillDocs: vi.fn(async () => []),
}));

const balanced = { level: "balanced", exceptions: [] } as unknown as EffectiveAutonomy;
const call = (id: string, name: string, args: Record<string, unknown>): LlmToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const tools = (...calls: LlmToolCall[]): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: null, tool_calls: calls }, finishReason: "tool_calls" });
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content }, finishReason: "stop" });

function vm() {
	return {
		execNavigate: vi.fn(async () => ({ url: "https://site.test/", title: "Site", ready: true, settled: true })),
		execBrowserSnapshot: vi.fn(async () => ({ url: "https://site.test/", title: "Site", total: 1, offset: 0, limit: 80, nextOffset: null, lines: ['button "Enviar" [a1]'], engine: "ax", tree: 'button "Enviar" [a1]', treeLength: 20 })),
		execBrowserAct: vi.fn(async (_s: string, p: { ref: string; action: string }) => ({ ok: true, ref: p.ref, action: p.action, newElements: [], newTotal: 0, changes: { added: "Enviado" } })),
	};
}

async function run(script: CompleteChatWithToolsResult[], options: { human?: boolean; origin?: string; actError?: Error } = {}) {
	const queue = [...script];
	const events: ComputerUseEvent[] = [];
	const seenTools: ChatTool[][] = [];
	const manager = vm();
	if (options.actError) manager.execBrowserAct.mockImplementation(async () => { throw options.actError!; });
	const params: ComputerUseParams = {
		manager: manager as unknown as SandboxManager,
		getSessionId: async () => "session-1",
		sandboxEnabled: true,
		model: "deepseek/deepseek-chat",
		apiKey: "test",
		runId: "run-nav",
		userId: "user-a",
		botId: "bot-1",
		conversationId: "conv-1",
		origin: options.origin ?? "chat",
		humanTurn: options.human ?? true,
		language: "pt-BR",
		messages: [{ role: "user", content: "Abra o site e envie" }],
		autonomy: balanced,
		onEvent: (event) => {
			events.push(event);
		},
		streamChat: async (p: CompleteChatWithToolsParams) => {
			seenTools.push(p.tools);
			const next = queue.shift();
			if (!next) throw new Error("roteiro acabou");
			return next;
		},
	};
	const result = await runEngineV3(params, {}, { sleep: async () => undefined });
	return { result, events, manager, seenTools };
}

beforeEach(() => vi.clearAllMocks());

describe("motor v3: navegador novo", () => {
	it("o array tem as 4 tools novas e nenhuma antiga (navigate, browser_read, browser_wait, screenshot...)", async () => {
		const { seenTools } = await run([say("Oi")]);
		const names = seenTools[0]!.map((tool) => tool.function.name);
		expect(names).toEqual(expect.arrayContaining(["browser_navigate", "browser_snapshot", "browser_act", "browser_tabs"]));
		for (const old of ["navigate", "browser_read", "browser_find", "browser_wait", "screenshot", "click", "computer"]) expect(names, old).not.toContain(old);
	});

	it("navega, vê e age em lote pelos handlers do v3; eventos SSE seguem o contrato de sempre", async () => {
		const { events, manager, result } = await run([
			tools(call("c1", "browser_navigate", { url: "https://site.test/" })),
			tools(call("c2", "browser_snapshot", {})),
			tools(call("c3", "browser_act", { actions: [{ do: "fill", ref: "a1", value: "oi" }, { do: "click", ref: "a1" }] })),
			say("Enviei."),
		]);
		expect(manager.execNavigate).toHaveBeenCalledWith("session-1", "https://site.test/");
		expect(manager.execBrowserSnapshot).toHaveBeenCalledTimes(1);
		expect(manager.execBrowserAct.mock.calls.map((c) => (c[1] as { action: string }).action)).toEqual(["type", "click"]);
		expect(result.text).toBe("Enviei.");
		const results = events.filter((e): e is Extract<ComputerUseEvent, { type: "tool_result" }> => e.type === "tool_result");
		expect(results.map((r) => [r.name, r.ok])).toEqual([["browser_navigate", true], ["browser_snapshot", true], ["browser_act", true]]);
		// Contrato: cada evento sobrevive ao parser SSE do web/celular sem perder o tipo e os campos de sempre.
		for (const event of events) {
			const parsed = parseSseBlock(`id: 1\ndata: ${JSON.stringify(event)}\n`);
			expect(parsed.event?.type).toBe(event.type);
		}
		const toolCalls = events.filter((e): e is Extract<ComputerUseEvent, { type: "tool_call" }> => e.type === "tool_call");
		expect(toolCalls.map((c) => c.name)).toEqual(["browser_navigate", "browser_snapshot", "browser_act"]);
		expect(JSON.parse(toolCalls[2]!.args).actions).toHaveLength(2);
	});

	it("falha no meio do lote volta como erro da tool (ok:false) com o que rodou; o run segue", async () => {
		const { events, result } = await run(
			[tools(call("c1", "browser_act", { actions: [{ do: "click", ref: "a9" }] })), say("Falhou.")],
			{ actError: new Error("Ref a9 não encontrado") },
		);
		const failed = events.find((e) => e.type === "tool_result");
		expect(failed).toMatchObject({ name: "browser_act", ok: false });
		expect((failed as { summary: string }).summary).toMatch(/Action 1 \(click\) failed: Ref a9/);
		expect(result.text).toBe("Falhou.");
	});

	it("sem humano (rotina) o navegador ainda lê e age na VM do bot (write_internal), sem cartão", async () => {
		const { events, manager } = await run([tools(call("c1", "browser_act", { actions: [{ do: "click", ref: "a1" }] })), say("ok")], { human: false, origin: "routine" });
		expect(manager.execBrowserAct).toHaveBeenCalledTimes(1);
		expect(events.some((e) => e.type === "confirm")).toBe(false);
	});
});
