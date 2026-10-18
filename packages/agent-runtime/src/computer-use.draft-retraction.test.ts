import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { applyComputerUseEventsToTranscript, type ComputerUseEvent } from "@workspace/shared";
import { runComputerUse } from "./computer-use.js";

/**
 * O rascunho da resposta final sai em deltas (balão escrito aos poucos). Se o
 * verificador de resposta o recusar, o balão é retirado (assistant_discard) e o
 * usuário só vê a versão refeita. LLM e verificador mockados.
 */

vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	listBotSkills: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

const verify = vi.hoisted(() => vi.fn());
vi.mock("./jev/answer-verifier.js", () => ({
	verifyDraftAnswer: verify,
	verifierNote: () => "Answer check (automatic, once): rewrite.",
}));

const call = (id: string, name: string, args: Record<string, unknown>): LlmToolCall => ({
	id,
	type: "function",
	function: { name, arguments: JSON.stringify(args) },
});
const turn = (content: string | null, ...calls: LlmToolCall[]): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content, tool_calls: calls },
});
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content } });

describe("rascunho recusado pelo verificador", () => {
	it("o balão do rascunho é retirado e só a versão refeita fica visível", async () => {
		verify.mockResolvedValueOnce(["Your draft contradicts the tool results."]).mockResolvedValue(null);
		const events: Array<Record<string, unknown> & { type: string }> = [];
		const queue = [
			turn("Vou procurar.", call("n1", "research_note", { sourceRef: "https://example.test/a", findings: "The plan costs 20 dollars.", keyFacts: ["US$ 20"], confidence: "high" })),
			say("Não encontrei o preço em nenhuma fonte."),
			say("O plano custa US$ 20."),
		];
		await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => {
				throw new Error("sem sandbox");
			},
			sandboxEnabled: false,
			model: "m",
			apiKey: "test",
			messages: [{ role: "user", content: "Quanto custa o plano?" }],
			botId: "bot-1",
			userId: "user-1",
			conversationId: "conv-draft",
			runId: "run-draft",
			origin: "chat",
			maxSteps: 8,
			onEvent: (event) => {
				events.push(event as never);
			},
			streamChat: async (_params, handlers) => {
				const next = queue.shift();
				if (!next) throw new Error("LLM extra");
				const text = next.message.content ?? "";
				for (let at = 0; at < text.length; at += 10) handlers?.onDelta?.(text.slice(at, at + 10));
				return { ...next, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
			},
		} as never);
		const rejectedStreamed = events.filter((event) => event.type === "assistant_delta").map((event) => String(event.delta)).join("");
		expect(rejectedStreamed).toContain("Não encontrei o preço");
		expect(events.some((event) => event.type === "assistant_discard")).toBe(true);
		const visible = applyComputerUseEventsToTranscript([], events as unknown as ComputerUseEvent[])
			.map((bubble) => bubble.text)
			.filter((text) => text.trim().length > 0);
		expect(visible).toEqual(["Vou procurar.", "O plano custa US$ 20."]);
	});
});
