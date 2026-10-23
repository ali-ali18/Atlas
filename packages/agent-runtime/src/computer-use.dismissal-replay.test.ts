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
 * Replay (LLM mockado) do caso real da Jujubinha: o bot voltou o gráfico de limite para a barra horizontal única e
 * o usuário respondeu "Dx sem esse mesmo, n tem algo q me agrade no momento" ("deixa sem esse mesmo, não tem nada
 * que me agrade"). O bot leu só o "deixa" e respondeu "Deixei como está". O prompt do 1º passo precisa trazer a
 * regra genérica: resposta informal vale pela intenção, e rejeição sem pedir substituto desfaz/remove.
 */

type Msg = { role: "user" | "assistant"; content: string };

async function replay(messages: Msg[], reply: string) {
	const prompts: string[] = [];
	const say: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: reply } };
	const result = await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "session-1",
		sandboxEnabled: false,
		apiKey: "test",
		model: "m",
		runId: "run-dismissal",
		userId: "user-a",
		botId: "bot-a",
		origin: "chat",
		contextEconomy: true,
		messages,
		maxSteps: 6,
		onEvent: () => undefined,
		streamChat: async (params) => {
			prompts.push(params.messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
			return say;
		},
	});
	return { prompts, result };
}

const LIMIT_CONVERSATION: Msg[] = [
	{ role: "user", content: "volta o gráfico de limite como era antes, não gostei" },
	{
		role: "assistant",
		content: "Voltei o gráfico de limite para a barra horizontal única: usado R$ 1.951,37 e disponível R$ 22.508,63, de R$ 24.460,00.",
	},
	{ role: "user", content: "Dx sem esse mesmo, n tem algo q me agrade no momento" },
];

beforeEach(() => vi.clearAllMocks());

describe("resposta informal que rejeita o resultado: o bot remove em vez de manter", () => {
	it("o prompt do 1º passo traz a regra genérica de intenção e de rejeição", async () => {
		const { prompts } = await replay([...LIMIT_CONVERSATION], "Pronto, tirei o gráfico de limite do painel.");
		const system = prompts[0]!;
		expect(system).toContain("Read short or informal replies by the user's intent in context, not by a literal or partial match of one word.");
		expect(system).toContain("When the user rejects the current result without asking for a replacement, undo or remove it instead of keeping it; never answer that you kept it as is.");
		// A regra é princípio, não glossário: o caso real não entra no prompt.
		expect(system).not.toMatch(/\bdx\b|deixa sem/i);
	});

	it("'Bom dia' também recebe a regra (núcleo), sem carregar grupo extra", async () => {
		const { prompts } = await replay([{ role: "user", content: "Bom dia" }], "Bom dia!");
		expect(prompts[0]).toContain("When the user rejects the current result without asking for a replacement");
		expect(prompts[0]).not.toContain("Live pages (`page_create`");
	});
});
