import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { ChatTool, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import { addMemoryEntry, getBotProfile } from "@workspace/db";
import { runComputerUse } from "./computer-use.js";
import { disciplineForModel } from "./context/model-discipline.js";
import { NATIVE_TOOL_GROUPS } from "./context/native-tools.js";
import { BROWSER_CHILD_TOOL_NAMES } from "@workspace/shared";
import { autoLanguageInstruction, languageInstruction, type BotLanguageSetting } from "@workspace/shared";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	addMemoryEntry: vi.fn(async () => ({ ok: true, entry: { id: "mem-1" } })),
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
	language?: BotLanguageSetting;
	languageContext?: { lastLanguage?: string | null; accountLocale?: string | null };
	/** Liga as sessões de código (precisa de conversationId). */
	withDev?: boolean;
}) {
	const requested: ChatTool[][] = [];
	const prompts: string[] = [];
	const results: Array<{ name: string; ok: boolean; summary: string }> = [];
	const eventTypes: string[] = [];
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
		...(input.withDev
			? {
					conversationId: "conv-1",
					devSession: {
						config: { enabled: true },
						store: { findForConversation: async () => null, update: async () => undefined },
						provider: {},
						getGithubToken: async () => ({ error: "sem github" }),
					} as never,
				}
			: {}),
		origin: input.origin ?? "chat",
		objective: input.objective,
		...(input.language ? { language: input.language } : {}),
		...(input.languageContext ? { languageContext: input.languageContext } : {}),
		contextEconomy: true,
		messages: input.messages,
		maxSteps: 6,
		onEvent: (event) => {
			eventTypes.push(event.type);
			if (event.type === "tool_result") results.push({ name: event.name, ok: event.ok, summary: event.summary });
		},
		streamChat: async (params) => {
			requested.push(JSON.parse(JSON.stringify(params.tools)) as ChatTool[]);
			prompts.push(params.messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
			return script.shift() ?? done;
		},
	});
	return {
		first: requested[0]!.map((tool) => tool.function.name),
		steps: requested.length,
		results,
		eventTypes,
		/** Tools do passo `step` (0 = primeiro) com o JSON completo, para medir o prefixo. */
		tools: (step = 0) => requested[step]!,
		system: (step = 0) => prompts[step]!,
		prefixChars: (step = 0) => JSON.stringify(requested[step]).length + prompts[step]!.length,
	};
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

describe("economia ligada: abas do navegador", () => {
	const flow = async (messages: Array<{ role: "user"; content: string }>, manager: Record<string, unknown>, script: CompleteChatWithToolsResult[], peek: () => string | null = () => "session-1") => {
		const toolsPerStep: string[][] = [];
		const results: Array<{ name: string; ok: boolean; summary: string }> = [];
		await runComputerUse({
			manager: manager as unknown as SandboxManager, getSessionId: async () => "session-1", peekSessionId: peek, apiKey: "test", model: "m",
			runId: "run-tabs", userId: "user-a", botId: "bot-a", origin: "chat", contextEconomy: true, maxSteps: 6, messages,
			onEvent: (event) => { if (event.type === "tool_result") results.push({ name: event.name, ok: event.ok, summary: event.summary }); },
			streamChat: async (params) => { toolsPerStep.push(params.tools.map((tool) => tool.function.name)); return script.shift() ?? done; },
		});
		return { toolsPerStep, results };
	};

	it("browser_tabs fica fora do 1º passo (mesmo no navegador) e do índice; só o grupo tabs a traz", async () => {
		expect(NATIVE_TOOL_GROUPS.browser.tools).not.toContain("browser_tabs");
		expect(Object.entries(NATIVE_TOOL_GROUPS).filter(([, g]) => g.tools.includes("browser_tabs")).map(([n]) => n)).toEqual(["tabs"]);
		const site = await replay({ messages: [{ role: "user", content: "abra o site loja.exemplo.com.br e clique em Entrar" }] });
		expect(site.first).not.toContain("browser_tabs");
		expect(site.system()).not.toContain("browser_tabs");
		// Subagentes de navegador têm a própria aba isolada: não trocam de aba.
		expect(BROWSER_CHILD_TOOL_NAMES).not.toContain("browser_tabs");
	});

	it("pedido que fala de aba (pt/en) já traz browser_tabs no 1º passo", async () => {
		for (const text of ["abra o site lms.test e depois volte para a outra aba", "open lms.test and switch to the other tab", "quais abas estão abertas no navegador?"]) {
			const { first } = await replay({ messages: [{ role: "user", content: text }] });
			expect(first, text).toContain("browser_tabs");
		}
	});

	it("clique que abre aba nova: o aviso sai no resultado e browser_tabs já está disponível no passo seguinte", async () => {
		const notices = ['A new tab opened: "Aula 1" — https://lms.test/aula. You are now on it. The previous tab is still open (use browser_tabs to switch back).'];
		const manager = {
			execNavigate: vi.fn(async () => ({ url: "https://lms.test", title: "Curso" })),
			execBrowserTabs: vi.fn(async () => ({ action: "list" as const, tabs: [{ index: 1, title: "Curso", url: "https://lms.test", active: false }, { index: 2, title: "Aula 1", url: "https://lms.test/aula", active: true }] })),
			takeTabNotice: vi.fn(() => notices.shift()),
		};
		const { toolsPerStep, results } = await flow(
			[{ role: "user", content: "abra o site lms.test e clique em Acessar" }], manager,
			[turn("navigate", { url: "https://lms.test" }), turn("browser_tabs", { action: "list" }, "c2"), done],
		);
		expect(toolsPerStep[0]).not.toContain("browser_tabs");
		expect(toolsPerStep[1]).toContain("browser_tabs");
		expect(results.map((r) => r.name)).toEqual(["navigate", "browser_tabs"]);
		expect(results[0]!.summary).toContain('[A new tab opened: "Aula 1" — https://lms.test/aula. You are now on it.');
		expect(results[1]).toMatchObject({ ok: true });
		expect(results[1]!.summary).toContain("2. [active]");
		expect(results[1]!.summary).not.toContain("A new tab opened");
		expect(manager.takeTabNotice).toHaveBeenCalledWith("session-1");
	});

	it("sem aviso, browser_tabs segue fora; chamada direta a ela carrega o grupo e pede para repetir", async () => {
		const manager = { execNavigate: vi.fn(async () => ({ url: "u", title: "t" })), takeTabNotice: vi.fn(() => undefined), execBrowserTabs: vi.fn() };
		const { toolsPerStep, results } = await flow([{ role: "user", content: "abra o site lms.test" }], manager, [turn("navigate", { url: "https://lms.test" }), turn("browser_tabs", { action: "list" }, "c2"), done]);
		expect(toolsPerStep[1]).not.toContain("browser_tabs");
		expect(results[1]!.summary).toMatch(/not loaded/i);
		expect(manager.execBrowserTabs).not.toHaveBeenCalled();
		expect(toolsPerStep[2]).toContain("browser_tabs");
	});

	it("o aviso nunca sobe nem reinicia a VM: sem sessão no run, só olha e não chama getSessionId", async () => {
		const getSessionId = vi.fn(async () => "session-1");
		const takeTabNotice = vi.fn(() => "A new tab opened: x");
		const manager = { execNavigate: vi.fn(async () => ({ url: "u", title: "t" })), takeTabNotice };
		const script = [turn("navigate", { url: "https://lms.test" }), done];
		const results: string[] = [];
		await runComputerUse({
			manager: manager as unknown as SandboxManager, getSessionId, peekSessionId: () => null, apiKey: "test", model: "m", runId: "run-tabs-down", userId: "user-a", botId: "bot-a",
			origin: "chat", contextEconomy: true, maxSteps: 4, messages: [{ role: "user", content: "abra o site lms.test" }],
			onEvent: (event) => { if (event.type === "tool_result") results.push(event.summary); },
			streamChat: async () => script.shift() ?? done,
		});
		// A própria navegação pede a sessão (uma vez); a leitura do aviso não pede outra.
		expect(getSessionId).toHaveBeenCalledTimes(1);
		expect(takeTabNotice).not.toHaveBeenCalled();
		expect(results[0]).not.toContain("A new tab opened");
	});

	it("browser_tabs com argumento inválido falha com a dica, sem chamar a VM", async () => {
		const manager = { execBrowserTabs: vi.fn(), takeTabNotice: vi.fn(() => undefined) };
		const { results } = await flow([{ role: "user", content: "quais abas estão abertas no site lms.test?" }], manager, [turn("browser_tabs", { action: "switch" }), done]);
		expect(manager.execBrowserTabs).not.toHaveBeenCalled();
		expect(results[0]).toMatchObject({ name: "browser_tabs", ok: false });
		expect(results[0]!.summary).toMatch(/needs "index"/);
	});
});

describe("economia ligada: lembrete", () => {
	it("'me lembra dia 03/10 às 10h e 20h' carrega as tools de rotina e a chamada roda de primeira", async () => {
		const { first, results } = await replay({
			messages: [{ role: "user", content: "me lembra de dar deploy dia 03/10 às 10h e às 20h aqui pelo chat" }],
			script: [turn("list_routines", {}), done],
		});
		expect(first).toEqual(expect.arrayContaining(["propose_routine", "list_routines"]));
		// Lembrete com data e hora não abre card de pergunta: o questionário nem entra no passo 1.
		expect(first).not.toContain("propose_questionnaire");
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
	it("'Bom dia' com idioma automático fica do tamanho do idioma fixo e leva a instrução no fim do prompt", async () => {
		const messages = [{ role: "user" as const, content: "Bom dia" }];
		const fixed = await replay({ messages, language: "pt-BR" });
		const auto = await replay({ messages, language: "auto", languageContext: { lastLanguage: "pt-BR" } });
		// A linha "Language:" da persona sai e a instrução de auto entra no fim: troca de uma linha pela outra.
		expect(auto.prefixChars() - fixed.prefixChars()).toBeLessThan(100);
		expect(auto.prefixChars()).toBeLessThan(40_000);
		const system = auto.system();
		expect(system).not.toContain("- Language:");
		expect(system).not.toContain(languageInstruction("pt-BR"));
		expect(system.split(autoLanguageInstruction("pt-BR"))).toHaveLength(2);
		expect(system.indexOf(autoLanguageInstruction("pt-BR"))).toBeGreaterThan(system.indexOf("Act, don't ask:"));
		// Nada de tool nova por causa do idioma: o conjunto de tools é o mesmo do idioma fixo.
		expect(auto.first).toEqual(fixed.first);
	});

	it("'Bom dia' mantém o prefixo pequeno: nenhuma tool rara e só o núcleo", async () => {
		const { first, steps, prefixChars } = await replay({ messages: [{ role: "user", content: "Bom dia" }] });
		// Prompt de sistema + schemas do passo 1: era ~42,6 mil chars antes da política única de agir primeiro.
		expect(prefixChars()).toBeLessThan(40_000);
		for (const rare of [
			"propose_routine",
			"create_file",
			"click",
			"propose_profile_update",
		]) {
			expect(first).not.toContain(rare);
		}
		expect(first).toEqual(expect.arrayContaining(["web_search", "web_extract", "mcp_tool_search"]));
		// V6: núcleo + grupo browser (7); o desktop e as raras ficam de fora.
		// +2: propose_skill e delete_skill viraram núcleo (o modelo decide quando criar skill).
		// -2: política de agir primeiro: propose_questionnaire e propose_plan saíram do núcleo (índice + intenção).
		expect(first).not.toContain("propose_questionnaire");
		expect(first).not.toContain("propose_plan");
		// +1: `memory` virou núcleo: sem ela no 1º passo o modelo não consegue salvar fato durável (P_MEMORY manda salvar).
		expect(first).toContain("memory");
		expect(first).not.toContain("memory_search");
		// +1: `sandbox_release` (desligar a VM) entra com o grupo browser; o prefixo continua abaixo de 40 mil chars.
		expect(first.length).toBeLessThanOrEqual(23);
		expect(steps).toBe(1);
	});

	it("conversa simples já pode salvar fato durável: `memory` add roda de primeira, sem carregar nada", async () => {
		const { first, results } = await replay({
			messages: [{ role: "user", content: "O CNPJ da minha empresa é 12.345.678/0001-90" }],
			script: [turn("memory", { action: "add", target: "memory", content: "CNPJ da empresa do usuário: 12.345.678/0001-90", category: "empresa" }), done],
		});
		expect(first).toContain("memory");
		expect(results[0]).toMatchObject({ name: "memory", ok: true });
		expect(results[0]!.summary).not.toMatch(/not loaded/i);
		expect(addMemoryEntry).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-a", botId: "bot-a", target: "memory" }));
	});

	it("rotina não recebe `memory` (não escreve memória)", async () => {
		const { first } = await replay({ origin: "routine", objective: "todo dia, lembre o que o usuário prefere", messages: [{ role: "user", content: "Execute a rotina." }] });
		expect(first).not.toContain("memory");
	});
});

describe("economia ligada: apresentações só entram quando o pedido é sobre apresentação", () => {
	const DECK_SCHEMA_MARKERS = ["Free layout", "rounded_rect", "template_file_id", "inspect_presentation", "scrim", "two_column", "chart-pie"];

	it("'Bom dia' mantém o prefixo pequeno e SEM o esquema do deck", async () => {
		const small = await replay({ messages: [{ role: "user", content: "Bom dia" }] });
		const text = small.system() + JSON.stringify(small.tools());
		for (const marker of DECK_SCHEMA_MARKERS) {
			// o índice cita o grupo em uma linha (nome da tool); o esquema não pode estar lá
			if (marker === "inspect_presentation") continue;
			expect(text, marker).not.toContain(marker);
		}
		expect(small.first).not.toContain("create_file");
		expect(small.first).not.toContain("inspect_presentation");
		// o índice dos grupos adiados mostra só uma linha do grupo, sem layouts nem campos
		expect(small.system()).toMatch(/- presentations: inspect_presentation\./);
		expect(small.system()).not.toContain("Plan a story first");
	});

	it("'faz uma apresentação…' carrega guia, create_file, inspect_presentation e generate_image já no passo 1", async () => {
		const small = await replay({ messages: [{ role: "user", content: "Bom dia" }] });
		const deck = await replay({ messages: [{ role: "user", content: "Faz uma apresentação de 8 slides sobre as vendas de outubro, com capa de tema agro" }] });
		expect(deck.first).toEqual(expect.arrayContaining(["create_file", "inspect_presentation", "generate_image"]));
		const system = deck.system();
		for (const needle of ["Plan a story first", "Free layout", "rounded_rect", "{gradient:{from,to,angle?}}", "template_file_id", "generate_image` FIRST", "chart-pie"]) expect(system, needle).toContain(needle);
		// o guia saiu do índice (já está carregado) e custa só neste pedido
		expect(system).not.toMatch(/- presentations: inspect_presentation\./);
		expect(deck.prefixChars() - small.prefixChars()).toBeGreaterThan(5_000);
		expect(deck.steps).toBe(1);
	});

	it("pedido de arquivo comum (PDF) não carrega o guia de apresentações", async () => {
		const pdf = await replay({ messages: [{ role: "user", content: "Gera um relatório em PDF das vendas" }] });
		expect(pdf.first).toContain("create_file");
		expect(pdf.first).not.toContain("inspect_presentation");
		expect(pdf.system()).not.toContain("Free layout");
		// a descrição do create_file é curta e aponta para o grupo, sem os campos de cada layout
		const createFile = pdf.tools().find((t) => t.function.name === "create_file")!;
		expect(JSON.stringify(createFile)).toContain("presentations");
		expect(JSON.stringify(createFile)).not.toContain("two_column");
		expect(JSON.stringify(createFile).length).toBeLessThan(4_500);
	});

	it("sem palavra-chave, o modelo pede 'presentations' e o guia vem no resultado da busca", async () => {
		const { tools, results, first } = await replay({
			messages: [{ role: "user", content: "Monta o material da reunião de amanhã" }],
			script: [turn("mcp_tool_search", { query: "presentations" }), done],
		});
		expect(first).not.toContain("inspect_presentation");
		expect(results[0]).toMatchObject({ name: "mcp_tool_search", ok: true });
		expect(results[0]!.summary).toContain("Loaded built-in tools");
		expect(results[0]!.summary).toContain("Free layout");
		expect(results[0]!.summary).toContain("template_file_id");
		expect(tools(1).map((t) => t.function.name)).toContain("inspect_presentation");
	});

	it("template anexado: o nome do arquivo .pptx na mensagem já carrega o guia", async () => {
		const { system, first } = await replay({ messages: [{ role: "user", content: "Usa esse modelo para o plano de 2027\n[Anexo: marca-corporativa.pptx (id att-9)]" }] });
		expect(first).toContain("inspect_presentation");
		expect(system()).toContain("Template: when the user attached a PowerPoint");
	});
});

describe("política de agir primeiro: pedido óbvio não abre questionário", () => {
	const OBVIOUS = "me escreve um parágrafo curto explicando o que é inflação, pro meu blog";

	it("o passo 1 traz a política única e não traz os cards de pergunta nem de plano", async () => {
		const { first, system, steps, results } = await replay({ messages: [{ role: "user", content: OBVIOUS }] });
		expect(first).not.toContain("propose_questionnaire");
		expect(first).not.toContain("propose_plan");
		const prompt = system();
		expect(prompt).toContain("Act, don't ask:");
		expect(prompt).toContain("Low-stakes choices (format, wording, order, defaults, which of two similar options) are yours: decide and say so in one line.");
		// As regras antigas e conflitantes de "pergunte com card" sumiram do núcleo.
		expect(prompt).not.toContain("Pergunte antes de agir");
		expect(prompt).not.toContain("2-4 opções claras");
		expect(steps).toBe(1);
		expect(results).toHaveLength(0);
	});

	it("modelo fraco que tenta abrir o card mesmo assim não mostra questionário no passo (a tool não está carregada)", async () => {
		const { results, eventTypes } = await replay({
			messages: [{ role: "user", content: OBVIOUS }],
			script: [
				turn("propose_questionnaire", { title: "Tom", items: [{ name: "tom", prompt: "Qual tom?", choices: [{ value: "formal" }, { value: "leve" }] }] }),
				{ model: "m", message: { role: "assistant", content: "A inflação é o aumento geral dos preços..." } },
			],
		});
		expect(results[0]).toMatchObject({ name: "propose_questionnaire", ok: false });
		expect(results[0]!.summary).toMatch(/not loaded/i);
		expect(eventTypes).not.toContain("questionnaire");
	});
});

describe("persona do bot no topo do prompt", () => {
	it("nome e papel do perfil aparecem uma vez, no começo, com o idioma; o núcleo não fala de nome nem idioma", async () => {
		const profile = { name: "TomTom", snippet: "", description: "Cuida das vendas da loja.", openRouterModel: null, language: "pt-BR" as const };
		vi.mocked(getBotProfile).mockImplementation(async () => profile);
		try {
			const { system } = await replay({ messages: [{ role: "user", content: "Bom dia" }] });
			const prompt = system();
			expect(prompt.startsWith('Persona:\n- You are "TomTom"')).toBe(true);
			expect(prompt.split('You are "TomTom"')).toHaveLength(2);
			expect(prompt).toContain("- Your role, from your profile: Cuida das vendas da loja.");
			expect(prompt.split("Always reply to the user in Brazilian Portuguese.")).toHaveLength(2);
			expect(prompt).not.toMatch(/IDENTIDADE DO BOT|Responda em português/);
		} finally {
			vi.mocked(getBotProfile).mockImplementation(async () => ({ description: "A bot that is already configured." }) as never);
		}
	});
});

describe("disciplina de execução por família de modelo (prefixo estável)", () => {
	const systemFor = async (model: string) => {
		const prompts: string[] = [];
		await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => "session-1",
			apiKey: "test",
			model,
			runId: "run-discipline",
			userId: "user-a",
			botId: "bot-a",
			origin: "chat",
			contextEconomy: true,
			messages: [{ role: "user", content: "Bom dia" }],
			maxSteps: 2,
			onEvent: () => undefined,
			streamChat: async (params) => {
				prompts.push(String(params.messages[0]!.content));
				return done;
			},
		});
		return prompts[0]!;
	};

	it("DeepSeek recebe o bloco completo logo após o núcleo; Claude só o mínimo", async () => {
		const deepseek = await systemFor("deepseek/deepseek-chat");
		const claude = await systemFor("anthropic/claude-sonnet-4.5");
		expect(deepseek).toContain(disciplineForModel("deepseek/deepseek-chat"));
		expect(deepseek).toContain("valid JSON that matches the schema");
		expect(claude).toContain(disciplineForModel("anthropic/claude-sonnet-4.5"));
		expect(claude).not.toContain("valid JSON that matches the schema");
		// Fica no prefixo estável: antes do índice de tools adiadas e da data de hoje.
		expect(deepseek.indexOf("Execution discipline:")).toBeLessThan(deepseek.indexOf("Built-in tools loaded on demand"));
		// A data e hora (muda a cada minuto) não fica no sistema: vai numa camada efêmera no fim do pedido.
		expect(deepseek).not.toContain("\nNow is ");
		// Mesmo modelo, mesmos bytes (cache).
		expect(await systemFor("deepseek/deepseek-chat")).toBe(deepseek);
	});
});

describe("economia ligada: prévia privada (grupo dev)", () => {
	beforeEach(() => vi.stubEnv("DEV_SANDBOX_ENABLED", "true"));
	afterEach(() => vi.unstubAllEnvs());
	it("'roda aí e me mostra' traz preview_start no passo 1 junto do shell; 'Bom dia' não traz nada de código", async () => {
		const asked = await replay({ withDev: true, messages: [{ role: "user", content: "roda aí e me mostra" }] });
		expect(asked.first).toEqual(expect.arrayContaining(["dev_session_start", "shell", "preview_start", "preview_stop"]));
		const greeting = await replay({ withDev: true, messages: [{ role: "user", content: "Bom dia" }] });
		for (const name of ["dev_session_start", "shell", "preview_start", "preview_stop"]) expect(greeting.first).not.toContain(name);
		expect(greeting.prefixChars()).toBeLessThan(asked.prefixChars());
	});

	it("o procedimento do grupo manda mandar o link, sem endereço interno nem print", async () => {
		const asked = await replay({ withDev: true, messages: [{ role: "user", content: "roda aí e me mostra" }] });
		expect(asked.system()).toMatch(/Showing a web project: .*preview_start/);
		expect(asked.system()).toMatch(/Never show localhost, 127\.0\.0\.1/);
		const greeting = await replay({ withDev: true, messages: [{ role: "user", content: "Bom dia" }] });
		// O índice de grupos sempre lista os nomes das tools; o procedimento (texto longo) só entra com o pedido.
		expect(greeting.system()).not.toMatch(/Showing a web project/);
	});
});
