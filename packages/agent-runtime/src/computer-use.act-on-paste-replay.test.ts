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
 * Replay (LLM mockado): o usuário cola um conteúdo pronto com uma instrução curta
 * ("altera os dados", "usa isso") no meio de uma tarefa. O prompt manda agir na
 * leitura mais plausível e nenhum mecanismo do runtime transforma a resposta
 * aplicada numa pergunta (nem refaz o balão).
 */

type Msg = { role: "user" | "assistant"; content: string };

async function replay(messages: Msg[], reply: string) {
	const prompts: string[] = [];
	const events: string[] = [];
	const say: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: reply } };
	const result = await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "session-1",
		sandboxEnabled: false,
		apiKey: "test",
		model: "m",
		runId: "run-paste",
		userId: "user-a",
		botId: "bot-a",
		origin: "chat",
		contextEconomy: true,
		messages,
		maxSteps: 6,
		onEvent: (event) => {
			events.push(event.type);
		},
		streamChat: async (params) => {
			prompts.push(params.messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
			return say;
		},
	});
	return { prompts, events, result };
}

/** Caso real: o bot juntou dados e ofereceu montar a mensagem; o usuário colou a mensagem pronta com outros dados. */
const QUOTE_CONVERSATION: Msg[] = [
	{ role: "user", content: "faz a cotação de frete do pedido 5120" },
	{
		role: "assistant",
		content:
			"Achei os dados do pedido 5120: cliente Loja Exemplo, CNPJ 11.222.333/0001-81, endereço, telefones e e-mails. Quer que eu monte a mensagem de cotação com esses dados e os 42 itens do pedido?",
	},
	{
		role: "user",
		content: [
			"Bom dia, tudo bem?",
			"🌿 Remetente: CNPJ: 12.345.678/0001-95 CEP: 01001-000",
			"🏢 Destinatário: CNPJ: 98.765.432/0001-98 CEP: 20040-020",
			"📦 Carga: Volumes: 7  Peso total: 43Kg  Valor da nota: R$ 1.712,67  Tipo de frete: CIF",
			"📏 Medidas: 1Vol. 70x50x15 / 1Vol. 50x30x12 / 2vol. 48x48x15 / 1Vol. 55x50x18 / 1Vol. 105x60x25 / 1vol. 60x40x50",
			"📞 Telefones: (11) 3000-1234 / (11) 99999-1234",
			"⏰ Horário limite: Até as 17:40",
			"altera os dados",
		].join("\n"),
	},
];

/** Outro domínio: rascunho de resumo em andamento; o usuário cola uma tabela e diz "usa isso". */
const TABLE_CONVERSATION: Msg[] = [
	{ role: "user", content: "escreve um resumo curto das vendas do trimestre para o time" },
	{ role: "assistant", content: "Rascunho: as vendas cresceram no trimestre, puxadas por camisetas. Quer que eu inclua os números por produto?" },
	{ role: "user", content: ["Produto | Jan | Fev | Mar", "Camiseta | 120 | 98 | 143", "Boné | 40 | 51 | 38", "Caneca | 77 | 80 | 91", "usa isso"].join("\n") },
];

beforeEach(() => vi.clearAllMocks());

describe("dados colados com instrução curta: o bot aplica em vez de perguntar", () => {
	it("o prompt do 1º passo manda agir na leitura mais plausível e aplicar ao trabalho em andamento", async () => {
		const { prompts } = await replay(QUOTE_CONVERSATION, "ok");
		const system = prompts[0]!;
		expect(system).toContain("Act on the most plausible reading.");
		expect(system).toContain("apply it to the work in progress (draft, message, document, routine) and show the updated result, keeping the user's format");
		expect(system).toContain("Do not ask what to change when the pasted content already shows it.");
		expect(system).toContain("Ask only when the missing information cannot be obtained with tools AND the plausible readings lead to materially different, costly or irreversible actions");
		expect(system).toContain("Write confirmations and approval cards still apply.");
		expect(system).toContain("goes as one short line after the result, never as a separate answer before acting");
		// A regra antiga ("2+ interpretações plausíveis" bastava para perguntar) saiu.
		expect(system).not.toContain("admite 2+ interpretações");
	});

	for (const [name, conversation, reply] of [
		[
			"cotação colada + 'altera os dados'",
			QUOTE_CONVERSATION,
			"Bom dia, tudo bem?\n🌿 Remetente: CNPJ: 12.345.678/0001-95 CEP: 01001-000\n🏢 Destinatário: CNPJ: 98.765.432/0001-98 CEP: 20040-020\n📦 Carga: Volumes: 7  Peso total: 43Kg  Valor da nota: R$ 1.712,67  Tipo de frete: CIF\n\nConferi: o destinatário bate com o pedido 5116.",
		],
		["tabela colada + 'usa isso'", TABLE_CONVERSATION, "As vendas cresceram no trimestre: camisetas 361, canecas 248, bonés 129. Usei os números da tabela."],
	] as const) {
		it(`${name}: a resposta aplicada sai num passo só, sem pergunta forçada nem revisão`, async () => {
			const { prompts, events, result } = await replay([...conversation], reply);
			expect(prompts).toHaveLength(1);
			expect(result.text).toBe(reply);
			expect(events).not.toContain("assistant_discard");
			expect(events).not.toContain("questionnaire");
		});
	}
});
