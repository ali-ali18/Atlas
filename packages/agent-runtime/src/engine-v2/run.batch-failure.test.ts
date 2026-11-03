/**
 * Motor v2: depois da primeira ação de página que falha NO MESMO passo, as seguintes do lote não rodam
 * (espelha computer-use.batch-failure.test.ts). Não aborta o run: o modelo recebe a informação e decide.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { ComputerUseEvent } from "@workspace/shared";
import { runEngineV2 } from "./run.js";
import { BATCH_SKIPPED_MESSAGE } from "../tools/batch-failure.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => ({ description: "Bot configurado." })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	upsertTaskListCard: vi.fn(async () => undefined),
	getConversationUntrustedAt: vi.fn(async () => null),
	markConversationUntrusted: vi.fn(async () => undefined),
}));

let seq = 0;
const call = (name: string, args: Record<string, unknown> = {}): LlmToolCall => ({ id: `v${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const turn = (calls: LlmToolCall[]): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: null, tool_calls: calls }, finishReason: "tool_calls" });
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content }, finishReason: "stop" });

const snap = async () => ({ url: "https://lms.test/", title: "t", total: 0, offset: 0, limit: 80, nextOffset: null, lines: [] });
const acted = (p: { ref: string; action: string }) => ({
	ok: true, ref: p.ref, action: p.action, url: "https://lms.test/", navigated: false, settled: true, newElements: [], newTotal: 0,
});

async function run(script: CompleteChatWithToolsResult[], manager: Record<string, unknown>) {
	const events: ComputerUseEvent[] = [];
	const queue = [turn([call("browser_snapshot")]), ...script];
	await runEngineV2(
		{
			manager: { execBrowserSnapshot: snap, ...manager } as unknown as SandboxManager,
			getSessionId: async () => "session-1",
			apiKey: "test",
			model: "m",
			runId: "run-batch-v2",
			userId: "user-a",
			botId: "bot-a",
			conversationId: "conv-1",
			origin: "chat",
			humanTurn: true,
			messages: [{ role: "user", content: "abra as três seções" }],
			timeZone: "America/Sao_Paulo",
			onEvent: (event) => {
				events.push(event);
			},
			streamChat: async (_params: CompleteChatWithToolsParams) => queue.shift() ?? say("fim"),
		},
		{ profile: "chat", promotable: false },
	);
	return events.filter((event): event is Extract<ComputerUseEvent, { type: "tool_result" }> => event.type === "tool_result");
}

beforeEach(() => vi.clearAllMocks());

describe("motor v2: lote para depois da primeira ação de página que falhou", () => {
	it("3 cliques no mesmo passo: o 1º falha, o 2º e o 3º não executam e o run segue", async () => {
		const execBrowserAct = vi.fn(async (_s: string, p: { ref: string; action: string }) => {
			if (p.ref === "e1") throw new Error("Element e1 is covered by a dialog");
			return acted(p);
		});
		const results = await run([
			turn([
				call("browser_act", { ref: "e1", action: "click" }),
				call("browser_act", { ref: "e2", action: "click" }),
				call("browser_act", { ref: "e3", action: "click" }),
			]),
			say("done"),
		], { execBrowserAct });
		expect(execBrowserAct).toHaveBeenCalledTimes(1);
		expect(results.slice(1).map((r) => r.ok)).toEqual([false, false, false]);
		expect(results[1]!.summary).toContain("covered by a dialog");
		expect(results[2]!.summary).toBe(BATCH_SKIPPED_MESSAGE);
		expect(results[3]!.summary).toBe(BATCH_SKIPPED_MESSAGE);
	});

	it("sem falha o lote inteiro roda", async () => {
		const execBrowserAct = vi.fn(async (_s: string, p: { ref: string; action: string }) => acted(p));
		const results = await run([
			turn([call("browser_act", { ref: "e1", action: "click" }), call("browser_act", { ref: "e2", action: "click" })]),
			say("done"),
		], { execBrowserAct });
		expect(execBrowserAct).toHaveBeenCalledTimes(2);
		expect(results.slice(1).every((r) => r.ok)).toBe(true);
	});
});
