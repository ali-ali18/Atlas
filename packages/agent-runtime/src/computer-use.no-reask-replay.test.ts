import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
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

/**
 * Replay (LLM mockado): o dono se irritou com o bot perguntando a cada 5 segundos coisas já respondidas e
 * escolhas reversíveis (qual SKU usar). O teste olha o prompt montado e o histórico que chega ao modelo,
 * sem depender do texto que o modelo escreveria.
 */

type Msg = { role: "user" | "assistant"; content: string };

async function firstPrompt(messages: Msg[]) {
	const systems: string[] = [];
	const sent: Msg[][] = [];
	const say: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "ok" } };
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "session-1",
		sandboxEnabled: false,
		apiKey: "test",
		model: "m",
		runId: "run-no-reask",
		userId: "user-a",
		botId: "bot-a",
		origin: "chat",
		contextEconomy: true,
		messages,
		maxSteps: 4,
		onEvent: () => undefined,
		streamChat: async (params) => {
			systems.push(params.messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
			sent.push(params.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role as Msg["role"], content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) })));
			return say;
		},
	});
	return { system: systems[0]!, history: sent[0]! };
}

beforeEach(() => vi.clearAllMocks());

describe("não repergunta: o que já foi respondido e as escolhas reversíveis", () => {
	it("o período respondido no turno anterior chega ao modelo, junto da regra de nunca reperguntar", async () => {
		const { system, history } = await firstPrompt([
			{ role: "user", content: "faz a cotação desses itens" },
			{ role: "assistant", content: "Qual período de preço você quer usar?" },
			{ role: "user", content: "o mês de outubro" },
			{ role: "assistant", content: "Anotado, outubro. Qual a unidade de entrega?" },
			{ role: "user", content: "pode seguir" },
		]);
		expect(history.map((m) => m.content).join("\n")).toContain("o mês de outubro");
		expect(system).toContain("Never ask for something the user already said or a tool can find");
		expect(system).toContain("One batched round of questions per task, at the start, each with a default");
	});

	it("cotação com várias opções de SKU: a política manda escolher, dizer a escolha e oferecer refazer", async () => {
		const { system } = await firstPrompt([{ role: "user", content: "cota 10 sacos de adubo; há 3 SKUs parecidos, faz a cotação" }]);
		expect(system).toContain("Low-stakes choices (format, wording, order, defaults, which of two similar options) are yours: decide and say so in one line. So are SKU, size, period or source (offer to redo)");
		expect(system).toContain("Never ask \"do you want me to...?\" for work already requested.");
		expect(system).toContain("Connector tools too (`list_orders` -> \"orders\").");
		expect(system).toContain("then bring the diagnosis, a fix and one yes/no question.");
	});
});
