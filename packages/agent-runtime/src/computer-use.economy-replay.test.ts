import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { ChatTool, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import { getBotProfile } from "@workspace/db";
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
 * Replays com a economia de contexto LIGADA (o padrão de produção): o que o modelo
 * enxerga no 1º passo para um pedido de navegador, um lembrete e um chat simples.
 */
const done: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "Pronto." } };
const turn = (name: string, args: Record<string, unknown>, id = "c1"): CompleteChatWithToolsResult => ({
	model: "m",
	message: {
		role: "assistant",
		content: null,
		tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } } satisfies LlmToolCall],
	},
});

async function replay(input: {
	messages: Array<{ role: "user" | "assistant"; content: string }>;
	script?: CompleteChatWithToolsResult[];
	origin?: "chat" | "routine";
	objective?: string;
}) {
	const requested: ChatTool[][] = [];
	const results: Array<{ name: string; ok: boolean; summary: string }> = [];
	const script = [...(input.script ?? [done])];
	const manager = {
		execNavigate: vi.fn(async () => ({ url: "https://loja.exemplo.com.br", title: "Loja" })),
		execClick: vi.fn(async () => ({})),
	} as unknown as SandboxManager;
	await runComputerUse({
		manager,
		getSessionId: async () => "session-1",
		apiKey: "test",
		model: "m",
		runId: "run-economy",
		userId: "user-a",
		botId: "bot-a",
		origin: input.origin ?? "chat",
		objective: input.objective,
		contextEconomy: true,
		messages: input.messages,
		maxSteps: 6,
		onEvent: (event) => {
			if (event.type === "tool_result") results.push({ name: event.name, ok: event.ok, summary: event.summary });
		},
		streamChat: async (params) => {
			requested.push(JSON.parse(JSON.stringify(params.tools)) as ChatTool[]);
			return script.shift() ?? done;
		},
	});
	return { first: requested[0]!.map((tool) => tool.function.name), steps: requested.length, results };
}

beforeEach(() => vi.clearAllMocks());

describe("economia ligada: tarefa de navegador", () => {
	it("'abra o site X e clique em Y' tem o navegador no passo 1 e navega sem 'tool não carregada'", async () => {
		const { first, steps, results } = await replay({
			messages: [{ role: "user", content: "abra o site loja.exemplo.com.br e clique em Entrar" }],
			script: [turn("navigate", { url: "https://loja.exemplo.com.br" }), done],
		});
		expect(first).toEqual(expect.arrayContaining(["navigate", "screenshot", "browser_read", "browser_find", "browser_snapshot", "browser_act", "browser_wait", "show_image"]));
		// V6: as ações por coordenada são do grupo desktop, que só entra sob demanda.
		for (const desktop of ["click", "type", "key", "scroll", "browser_click", "browser_type", "browser_text", "browser_links"]) expect(first).not.toContain(desktop);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ name: "navigate", ok: true });
		expect(results[0]!.summary).not.toMatch(/not loaded/i);
		expect(steps).toBe(2);
	});

	it("pedido de app fora do navegador traz o grupo desktop; sem isso a chamada direta carrega e repete", async () => {
		const withDesktop = await replay({ messages: [{ role: "user", content: "abra o aplicativo desktop e arraste o ícone" }] });
		expect(withDesktop.first).toEqual(expect.arrayContaining(["click", "type", "key", "scroll"]));
		const direct = await replay({
			messages: [{ role: "user", content: "abra o site loja.exemplo.com.br" }],
			script: [turn("click", { x: 5, y: 5 }), done],
		});
		expect(direct.results[0]!.summary).toMatch(/not loaded/i);
	});

	it("pedido sem palavra-chave no meio da tarefa ('sim, continue') mantém o navegador pela fala anterior", async () => {
		const { first } = await replay({
			messages: [
				{ role: "user", content: "entre no site loja.exemplo.com.br e preencha o cadastro" },
				{ role: "assistant", content: "Quer que eu envie o formulário agora?" },
				{ role: "user", content: "sim, continue" },
			],
		});
		expect(first).toContain("browser_snapshot");
	});

	it("rotina com objetivo de computador carrega o navegador pelo objetivo", async () => {
		const { first } = await replay({
			origin: "routine",
			objective: "todo dia abra o site loja.exemplo.com.br e confira o preço",
			messages: [{ role: "user", content: "Execute a rotina." }],
		});
		expect(first).toContain("navigate");
	});
});

describe("economia ligada: lembrete", () => {
	it("'me lembra dia 03/10 às 10h e 20h' carrega as tools de rotina e a chamada roda de primeira", async () => {
		const { first, results } = await replay({
			messages: [{ role: "user", content: "me lembra de dar deploy dia 03/10 às 10h e às 20h aqui pelo chat" }],
			script: [turn("list_routines", {}), done],
		});
		expect(first).toEqual(expect.arrayContaining(["propose_routine", "list_routines", "propose_questionnaire"]));
		expect(results[0]).toMatchObject({ name: "list_routines", ok: true });
		expect(results[0]!.summary).not.toMatch(/not loaded/i);
	});
});

describe("economia ligada: onboarding do bot", () => {
	it("bot sem briefing já tem propose_profile_update no 1º passo", async () => {
		vi.mocked(getBotProfile).mockResolvedValueOnce(null);
		const { first } = await replay({ messages: [{ role: "user", content: "oi" }] });
		expect(first).toContain("propose_profile_update");
	});

	it("bot configurado em chat simples não carrega o perfil", async () => {
		const { first } = await replay({ messages: [{ role: "user", content: "oi" }] });
		expect(first).not.toContain("propose_profile_update");
	});
});

describe("economia ligada: chat simples", () => {
	it("'Bom dia' mantém o prefixo pequeno: nenhuma tool rara e só o núcleo", async () => {
		const { first, steps } = await replay({ messages: [{ role: "user", content: "Bom dia" }] });
		for (const rare of [
			"propose_routine",
			"memory",
			"create_file",
			"click",
			"propose_profile_update",
		]) {
			expect(first).not.toContain(rare);
		}
		expect(first).toEqual(expect.arrayContaining(["web_search", "web_extract", "mcp_tool_search", "propose_questionnaire"]));
		// V6: núcleo + grupo browser (7); o desktop e as raras ficam de fora.
		// +2: propose_skill e delete_skill viraram núcleo (o modelo decide quando criar skill).
		// +1: propose_plan virou núcleo (o plano aparece antes das escritas).
		expect(first).toContain("propose_plan");
		expect(first.length).toBeLessThanOrEqual(23);
		expect(steps).toBe(1);
	});
});
