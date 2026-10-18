import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { sendBotMessage } from "@workspace/db";
import { runComputerUse } from "./computer-use.js";

/** Conversa entre bots no loop: a tool só existe com 2+ bots e o resultado volta ao modelo. LLM mockado. */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		sendBotMessage: vi.fn(async () => ({ id: "m1", targetId: "bot-2", targetName: "Bia" })),
		getBotProfile: vi.fn(async () => null),
		saveSkillPendingIntent: vi.fn(async () => undefined),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
	};
});

const toolCall = (name: string, args: Record<string, unknown>): CompleteChatWithToolsResult => ({
	model: "test-model",
	message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] },
});
const done: CompleteChatWithToolsResult = { model: "test-model", message: { role: "assistant", content: "Pedi pra Bia, te aviso quando responder." } };

async function run(input: { bots: Array<{ id: string; isPrimary?: boolean }>; origin?: string; calls: CompleteChatWithToolsResult[] }) {
	const seenTools: string[][] = [];
	const results: Array<{ name: string; ok: boolean; summary: string }> = [];
	const queue = [...input.calls];
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => {
			throw new Error("nao deve criar sessao");
		},
		sandboxEnabled: false,
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: "peça o saldo pra Bia" }],
		botId: "bot-1",
		userId: "user-1",
		conversationId: "conv-1",
		runId: "run-1",
		origin: (input.origin ?? "chat") as "chat",
		maxSteps: 4,
		listBotRoster: async () => input.bots,
		onEvent: (event) => {
			if (event.type === "tool_result") results.push(event as never);
		},
		streamChat: async (params) => {
			seenTools.push(params.tools.map((tool) => tool.function.name));
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
	});
	return { seenTools, results };
}

describe("send_to_bot no loop do agente", () => {
	it("não aparece com um bot só", async () => {
		const { seenTools } = await run({ bots: [{ id: "bot-1" }], calls: [done] });
		expect(seenTools[0]).not.toContain("send_to_bot");
		expect(seenTools[0]).not.toContain("set_primary_bot");
	});

	it("não aparece em rotina", async () => {
		const { seenTools } = await run({ bots: [{ id: "bot-1" }, { id: "bot-2" }], origin: "routine", calls: [done] });
		expect(seenTools[0]).not.toContain("send_to_bot");
	});

	it("com 2+ bots aparece e o resultado volta como delivered", async () => {
		const { seenTools, results } = await run({
			bots: [{ id: "bot-1" }, { id: "bot-2" }],
			calls: [toolCall("send_to_bot", { bot: "Bia", message: "qual o saldo?", title: "Saldo" }), done],
		});
		expect(seenTools[0]).toContain("send_to_bot");
		expect(seenTools[0]).toContain("set_primary_bot");
		expect(sendBotMessage).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", fromBotId: "bot-1", fromRunId: "run-1", bot: "Bia" }));
		expect(results[0]).toMatchObject({ name: "send_to_bot", ok: true });
		expect(JSON.parse(results[0]!.summary)).toMatchObject({ delivered: true, target: "Bia" });
	});

	it("com bot principal definido, set_primary_bot some", async () => {
		const { seenTools } = await run({ bots: [{ id: "bot-1", isPrimary: true }, { id: "bot-2" }], calls: [done] });
		expect(seenTools[0]).toContain("send_to_bot");
		expect(seenTools[0]).not.toContain("set_primary_bot");
	});
});
