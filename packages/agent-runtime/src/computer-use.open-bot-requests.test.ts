import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";

/** Pedido a outro bot sem resposta: o turno seguinte do remetente vê o bloco curto e não inventa o resultado. */

vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	listBotSkills: vi.fn(async () => []),
	searchMemoryEntries: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

async function firstSystemTexts(openBotRequests?: Parameters<typeof runComputerUse>[0]["openBotRequests"]) {
	let first: CompleteChatWithToolsParams["messages"] | undefined;
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => {
			throw new Error("sem sandbox");
		},
		sandboxEnabled: false,
		model: "m",
		apiKey: "test",
		messages: [{ role: "user", content: "e o PDF da Semana 2?" }],
		botId: "bot-1",
		userId: "user-1",
		conversationId: "conv-1",
		origin: "chat",
		maxSteps: 3,
		openBotRequests,
		onEvent: () => undefined,
		streamChat: async (params) => {
			first ??= JSON.parse(JSON.stringify(params.messages));
			return { model: "m", message: { role: "assistant", content: "Ainda estou esperando o Bobinho." } };
		},
	} as never);
	return (first ?? []).filter((m) => m.role === "system").map((m) => String(m.content));
}

describe("pedidos a outros bots sem resposta", () => {
	it("o bloco [open_bot_requests] chega ao modelo com o atraso marcado", async () => {
		const texts = await firstSystemTexts([{ botName: "Bobinho", title: "PDF da Semana 2", status: "delivered", createdAt: new Date(Date.now() - 45 * 60_000) }]);
		const block = texts.find((t) => t.startsWith("[open_bot_requests]"));
		expect(block).toContain('Bobinho: "PDF da Semana 2"');
		expect(block).toContain("overdue");
	});

	it("sem pedidos em aberto, nenhum bloco", async () => {
		const texts = await firstSystemTexts([]);
		expect(texts.some((t) => t.startsWith("[open_bot_requests]"))).toBe(false);
	});
});
