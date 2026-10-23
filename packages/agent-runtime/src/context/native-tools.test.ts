import { describe, expect, it } from "vitest";
import type { ChatTool } from "@workspace/llm";
import { routeContextGroups } from "./intent-router.js";
import { economyRouterText, orderEconomyTools, planContextEconomy } from "./economy.js";
import { createNativeDeferral } from "./native-deferral.js";
import { NATIVE_TOOL_GROUPS, deferredToolsIndex, nativeToolGroupOf, planNativeTools } from "./native-tools.js";
import { contextEconomyEnabled } from "./flag.js";
import type { ContextGroup } from "./prompt-blocks.js";

const tool = (name: string): ChatTool => ({
	type: "function",
	function: { name, description: `${name} description`, parameters: { type: "object", properties: {} } },
});
const everyName = [
	"web_search",
	"web_extract",
	"delegate_task",
	"read_cached_result",
	"set_autonomy",
	...Object.values(NATIVE_TOOL_GROUPS).flatMap((group) => group.tools),
];
const all = everyName.map(tool);
const names = (tools: ChatTool[]) => tools.map((entry) => entry.function.name);

describe("catálogo das tools nativas raras", () => {
	it("cada tool pertence a um grupo só", () => {
		const seen = new Set<string>();
		for (const group of Object.values(NATIVE_TOOL_GROUPS)) {
			for (const name of group.tools) {
				expect(seen.has(name)).toBe(false);
				seen.add(name);
			}
		}
		expect(nativeToolGroupOf("propose_routine")).toBe("routines");
		expect(nativeToolGroupOf("web_search")).toBeUndefined();
	});

	it("o plano separa núcleo, pré-carregadas (ordem do catálogo) e adiadas", () => {
		const plan = planNativeTools(all, new Set<ContextGroup>(["routines"]));
		expect(names(plan.core)).toEqual(["web_search", "web_extract", "delegate_task", "read_cached_result", "set_autonomy"]);
		expect(names(plan.preloaded)).toEqual(["list_routines", "propose_routine", "routine_group", "routine_control", "github_list_repos"]);
		// Política de agir primeiro: os cards de pergunta e de plano saíram do núcleo (entram por intenção ou busca).
		expect(plan.deferred.get("propose_questionnaire")?.group).toBe("questionnaire");
		expect(plan.deferred.get("propose_plan")?.group).toBe("plan");
		expect(plan.deferred.has("propose_routine")).toBe(false);
	});

	it("tool que o filtro já tirou não aparece no plano nem no índice", () => {
		const eligible = all.filter((entry) => entry.function.name !== "create_file");
		const plan = planNativeTools(eligible, new Set());
		expect(plan.deferred.has("create_file")).toBe(false);
		expect(deferredToolsIndex(eligible)).not.toContain("create_file");
		expect(deferredToolsIndex(eligible)).toContain("routines: list_routines, propose_routine");
	});

	it("a ordem final põe o condicional por último e ordena o conector por nome", () => {
		const plan = planNativeTools(all, new Set<ContextGroup>(["files"]));
		const ordered = orderEconomyTools({
			plan,
			searchTool: tool("mcp_tool_search"),
			connectorTools: [tool("mcp__b__x"), tool("mcp__a__x")],
		});
		expect(names(ordered)).toEqual([
			"web_search",
			"web_extract",
			"delegate_task",
			"read_cached_result",
			"mcp_tool_search",
			"mcp__a__x",
			"mcp__b__x",
			"create_file",
			"set_autonomy",
		]);
	});

	it("a flag liga por padrão e desliga com off/0/false", () => {
		expect(contextEconomyEnabled({})).toBe(true);
		expect(contextEconomyEnabled({ ATLAS_CONTEXT_ECONOMY: "off" })).toBe(false);
		expect(contextEconomyEnabled({ ATLAS_CONTEXT_ECONOMY: "0" })).toBe(false);
		expect(contextEconomyEnabled({ ATLAS_CONTEXT_ECONOMY: "false" })).toBe(false);
		expect(contextEconomyEnabled({ ATLAS_CONTEXT_ECONOMY: "on" })).toBe(true);
	});
});

describe("roteador de intenção", () => {
	const groups = (text: string, extra: Partial<Parameters<typeof routeContextGroups>[0]> = {}) =>
		[...routeContextGroups({ text, ...extra })].sort();

	it("pedido sem intenção não carrega nada", () => {
		expect(groups("Bom dia")).toEqual([]);
		expect(groups("Qual é a capital da França?")).toEqual([]);
	});

	it("reconhece rotina, skill, arquivo, imagem, memória e navegador (pt, en)", () => {
		expect(groups("me lembra dia 03/10 às 10h e 20h")).toContain("routines");
		expect(groups("todo dia às 9h me manda um resumo")).toContain("routines");
		expect(groups("remind me every day")).toContain("routines");
		expect(groups("gera um PDF com o relatório")).toContain("files");
		expect(groups("faz uma planilha de gastos")).toContain("files");
		expect(groups("me mostra a imagem")).toContain("images");
		expect(groups("lembra que meu nome é Ana")).toContain("memory");
		expect(groups("abre o site da loja e clica em comprar")).toContain("browser");
	});

	it("URL ou domínio leva navegador, imagens e escada de pesquisa", () => {
		expect(groups("resume https://example.com/post")).toEqual(["browser", "images", "web"]);
		expect(groups("o que tem em example.com?")).toContain("browser");
	});

	it("onboarding carrega questionário e memória; perfil só se a regra de perfil permite", () => {
		expect(groups("oi", { onboarding: true })).toEqual(["memory", "questionnaire"]);
		expect(groups("oi", { onboarding: true, profileAllowed: true })).toEqual(["memory", "profile", "questionnaire"]);
	});

	it("imagem anexada carrega o grupo de imagens", () => {
		expect(groups("o que é isso?", { hasImageAttachments: true })).toEqual(["images"]);
	});

	it("pega as formas coloquiais que antes escapavam (cada N, clique, o que você lembra)", () => {
		expect(groups("muda pra cada 2 horas")).toContain("routines");
		expect(groups("clique em Salvar")).toContain("browser");
		expect(groups("digite o CPF no campo")).toContain("browser");
		expect(groups("o que você lembra de mim?")).toContain("memory");
	});

	it("lembrete carrega a rotina sem o questionário (se faltar a hora, a pergunta é uma frase)", () => {
		expect(groups("me lembra de dar deploy amanhã")).toContain("routines");
		expect(groups("me lembra de dar deploy amanhã")).not.toContain("questionnaire");
	});

	it("é determinístico e insensível a acento e caixa", () => {
		expect(groups("ME LEMBRA AMANHÃ")).toEqual(groups("me lembra amanha"));
	});
});

describe("plano de economia", () => {
	const base = {
		eligible: all,
		routerText: "Bom dia",
		onboarding: false,
		hasImageAttachments: false,
		profileAllowed: false,
		profileRequested: false,
	};

	it("pedido do usuário para mudar o bot abre o perfil só quando a regra permite", () => {
		expect(planContextEconomy({ ...base, profileRequested: true, profileAllowed: true }).groups.has("profile")).toBe(true);
		expect(planContextEconomy({ ...base, profileRequested: true, profileAllowed: false }).groups.has("profile")).toBe(false);
	});

	it("onboarding do bot incompleto deixa a tool de perfil à mão (só se a regra de perfil permite)", () => {
		expect(planContextEconomy({ ...base, onboardingIncomplete: true, profileAllowed: true }).groups.has("profile")).toBe(true);
		expect(planContextEconomy({ ...base, onboardingIncomplete: true, profileAllowed: false }).groups.has("profile")).toBe(false);
	});

	it("criar/editar skill é núcleo: nenhuma palavra carrega ou esconde propose_skill", () => {
		expect(nativeToolGroupOf("propose_skill")).toBeUndefined();
		expect(nativeToolGroupOf("delete_skill")).toBeUndefined();
		expect(planContextEconomy({ ...base, routerText: "crie uma skill de proposta" }).groups.has("skills")).toBe(false);
	});

	it("retomada repõe os grupos das tools que já estavam carregadas", () => {
		const resumed = planContextEconomy({ ...base, resumedToolNames: ["propose_routine", "web_search"] });
		expect(resumed.groups.has("routines")).toBe(true);
		expect(names(resumed.plan.preloaded)).toContain("propose_routine");
	});
});

describe("texto do roteador", () => {
	const msg = (role: string, content: string) => ({ role, content });

	it("soma o objetivo do run e a fala anterior do usuário à última fala", () => {
		const text = economyRouterText({
			objective: "abra o site da loja",
			messages: [msg("user", "preciso de ajuda com o site"), msg("assistant", "claro"), msg("user", "sim, continue")],
			lastUserMessage: "sim, continue",
		});
		expect(text).toContain("sim, continue");
		expect(text).toContain("abra o site da loja");
		expect(text).toContain("preciso de ajuda com o site");
		expect([...routeContextGroups({ text })]).toContain("browser");
	});

	it("rotina lê só o objetivo e conversa sem pedido continua sem grupos", () => {
		expect(economyRouterText({ origin: "routine", objective: "todo dia resuma", messages: [], lastUserMessage: "x" })).toBe("todo dia resuma");
		const plain = economyRouterText({ messages: [msg("user", "bom dia"), msg("user", "tudo bem?")], lastUserMessage: "tudo bem?" });
		expect([...routeContextGroups({ text: plain })]).toEqual([]);
	});
});

describe("carregamento sob demanda", () => {
	function setup() {
		const plan = planNativeTools(all, new Set());
		const tools = [...plan.core];
		const prompted = new Set<ContextGroup>();
		return { deferral: createNativeDeferral({ deferred: plan.deferred, tools, promptedGroups: prompted }), tools, prompted };
	}

	it("nome exato carrega só a tool; palavra distintiva carrega o grupo; palavra genérica não casa", () => {
		const { deferral } = setup();
		expect(deferral.match("propose_routine", 6)).toEqual({ names: ["propose_routine"], strong: true });
		expect(deferral.match("set a reminder", 6).names).toEqual(["list_routines", "propose_routine", "routine_group", "routine_control", "github_list_repos"]);
		expect(deferral.match("lista os itens", 6).names).toEqual([]);
		expect(deferral.match("routines", 6).strong).toBe(true);
	});

	it("carregar acrescenta ao fim, tira do pool, e só devolve as notas do grupo uma vez", () => {
		const { deferral, tools, prompted } = setup();
		const before = names(tools);
		const first = deferral.load(["propose_routine"]);
		expect(first.loaded).toEqual(["propose_routine"]);
		expect(first.notes).toContain("Lembretes:");
		expect(names(tools)).toEqual([...before, "propose_routine"]);
		expect(prompted.has("routines")).toBe(true);
		expect(deferral.isDeferred("propose_routine")).toBe(false);
		const second = deferral.loadGroupOf("list_routines");
		expect(second.loaded).toEqual(["list_routines", "routine_group", "routine_control", "github_list_repos"]);
		expect(second.notes).toBe("");
		expect(deferral.load(["propose_routine"]).loaded).toEqual([]);
	});

	it("o limite não corta um grupo no meio, mas respeita o total quando já há grupo", () => {
		const { deferral } = setup();
		const match = deferral.match("browser routine skill", 4);
		expect(match.names.length).toBeLessThanOrEqual(NATIVE_TOOL_GROUPS.browser.tools.length);
		expect(new Set(match.names.map((name) => nativeToolGroupOf(name))).size).toBe(1);
	});
});
