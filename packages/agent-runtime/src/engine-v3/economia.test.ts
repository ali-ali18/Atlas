/**
 * Harness v3, PR5: economia do prefixo e a ponte `tool_search`/`tool_call`, com LLM roteirizado e sem rede.
 * Bot típico: VM ligada + 50 conectores falsos (6 tools cada, nomes que colidem com as nativas). O "Bom dia" do v3
 * cabe em 20 mil caracteres de prefixo (system + schemas) e é menor que o do v2 no mesmo cenário.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTool, CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmMessage, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { AgentRunCheckpoint, ComputerUseEvent, EffectiveAutonomy } from "@workspace/shared";
import { languageInstruction } from "@workspace/shared";
import { buildMcpToolset, type McpToolsetConnection } from "../mcp/registry.js";
import type { McpRuntime } from "../mcp/runtime.js";
import type { ComputerUseParams } from "../run-types.js";
import { runEngineV2 } from "../engine-v2/run.js";
import { briefToolFilter } from "../tools/daily-brief.js";
import { runEngineV3 } from "./loop.js";
import { CONTEXT_HEADER } from "./prompt.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => ({ name: "Cookie", description: "Assistente pessoal do dono.", language: "pt-BR" })),
	searchMemoryEntries: vi.fn(async () => []),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	upsertTaskListCard: vi.fn(async () => undefined),
	getConversationUntrustedAt: vi.fn(async () => null),
	markConversationUntrusted: vi.fn(async () => undefined),
	markMcpTaskGrantsUntrusted: vi.fn(async () => undefined),
	saveSkillPendingIntent: vi.fn(async () => undefined),
	listSkillDocs: vi.fn(async () => []),
}));

const balanced = { level: "balanced", exceptions: [] } as unknown as EffectiveAutonomy;
const fiftyConnectors: McpToolsetConnection[] = Array.from({ length: 50 }, (_, index) => ({
	id: `conn-${index}`,
	slug: `svc${index}`,
	name: `Servico ${index}`,
	disabledTools: [],
	tools: [
		{ name: "create_bot", description: "Create a new bot user in this workspace.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, annotations: { readOnlyHint: false } },
		{ name: "create_page", description: "Create a page in the workspace.", inputSchema: { type: "object", properties: { title: { type: "string" } } }, annotations: { readOnlyHint: false } },
		{ name: "list_items", description: "List items with filters and pagination.", inputSchema: { type: "object", properties: { query: { type: "string" }, page: { type: "number" } } }, annotations: { readOnlyHint: true } },
		{ name: "get_item", description: "Get one item by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, annotations: { readOnlyHint: true } },
		{ name: "send_message", description: "Send a message to a channel.", inputSchema: { type: "object", properties: { channel: { type: "string" }, text: { type: "string" } } }, annotations: { readOnlyHint: false } },
		{ name: "search", description: "Search the workspace.", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } },
	],
}));

const call = (id: string, name: string, args: Record<string, unknown> | string = {}): LlmToolCall => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
const tools = (...calls: LlmToolCall[]): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: null, tool_calls: calls }, finishReason: "tool_calls" });
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content }, finishReason: "stop" });
const textOf = (message: LlmMessage) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""));

type Seen = { params: CompleteChatWithToolsParams; system: string; context: string; toolsChars: number; names: string[] };

const mcpCall = vi.fn(async () => ({ ok: true, text: "ok", truncated: false }));
const mcpOf = (connections: McpToolsetConnection[]) => ({ toolset: buildMcpToolset(connections, { autonomy: balanced }), call: mcpCall }) as unknown as McpRuntime;

function baseParams(input: { text: string; script: CompleteChatWithToolsResult[]; seen: Seen[]; events: ComputerUseEvent[]; checkpoints?: AgentRunCheckpoint[]; extra?: Partial<ComputerUseParams> }): ComputerUseParams {
	const queue = [...input.script];
	const mcp = mcpOf(fiftyConnectors);
	return {
		manager: {} as SandboxManager,
		getSessionId: async () => "session-1",
		sandboxEnabled: true,
		model: "deepseek/deepseek-chat",
		apiKey: "test",
		runId: "run-eco",
		userId: "user-a",
		botId: "bot-cookie",
		conversationId: "conv-1",
		origin: "chat",
		humanTurn: true,
		language: "pt-BR",
		messages: [{ role: "user", content: input.text }],
		timeZone: "America/Sao_Paulo",
		mcp,
		autonomy: balanced,
		onEvent: (event) => {
			input.events.push(event);
		},
		onCheckpoint: async (checkpoint) => {
			input.checkpoints?.push(JSON.parse(JSON.stringify(checkpoint)) as AgentRunCheckpoint);
		},
		streamChat: async (params) => {
			const systems = params.messages.filter((message) => message.role === "system").map(textOf);
			const context = params.messages.find((message) => message.role === "user" && textOf(message).startsWith(CONTEXT_HEADER));
			input.seen.push({ params, system: systems.join("\n"), context: context ? textOf(context) : "", toolsChars: JSON.stringify(params.tools).length, names: params.tools.map((tool: ChatTool) => tool.function.name) });
			const next = queue.shift();
			if (!next) throw new Error("roteiro do modelo acabou");
			return next;
		},
		...input.extra,
	};
}

async function v3(input: { text: string; script: CompleteChatWithToolsResult[]; extra?: Partial<ComputerUseParams> }) {
	const seen: Seen[] = [];
	const events: ComputerUseEvent[] = [];
	const checkpoints: AgentRunCheckpoint[] = [];
	const result = await runEngineV3(baseParams({ ...input, seen, events, checkpoints }), {}, { sleep: async () => undefined });
	const results = events.filter((event): event is Extract<ComputerUseEvent, { type: "tool_result" }> => event.type === "tool_result");
	const calls = events.filter((event): event is Extract<ComputerUseEvent, { type: "tool_call" }> => event.type === "tool_call");
	return { result, seen, events, results, calls, checkpoints };
}

beforeEach(() => vi.clearAllMocks());

describe("motor v3: economia do \"Bom dia\" (VM + 50 conectores)", () => {
	it("prefixo (system + schemas) <= 20 mil caracteres e menor que o v2 no mesmo cenário", async () => {
		const three = await v3({ text: "Bom dia", script: [say("Bom dia! Como posso ajudar?")] });
		const v3First = three.seen[0]!;
		const v3Prefix = v3First.system.length + v3First.toolsChars;

		const v2Seen: Seen[] = [];
		await runEngineV2(baseParams({ text: "Bom dia", script: [say("Bom dia!")], seen: v2Seen, events: [] }), { profile: "chat", promotable: false });
		const v2First = v2Seen[0]!;
		const v2Prefix = v2First.system.length + v2First.toolsChars;

		// Números reais do PR5 (relatados no PR): prefixo do v3 e do v2, e o bloco de contexto do v3 (manifesto).
		console.info(`[economia] v3 system=${v3First.system.length} schemas=${v3First.toolsChars} prefixo=${v3Prefix} contexto=${v3First.context.length} | v2 system=${v2First.system.length} schemas=${v2First.toolsChars} prefixo=${v2Prefix}`);
		expect(v3First.system.length).toBeLessThanOrEqual(6_000);
		expect(v3Prefix).toBeLessThanOrEqual(20_000);
		expect(v3Prefix).toBeLessThan(v2Prefix);
		// Mesmo contando o manifesto (todas as ~350 tools pelo nome), o v3 fica abaixo do v2.
		expect(v3Prefix + v3First.context.length).toBeLessThan(v2Prefix);
	});

	it("o navegador inteiro está no núcleo (D8) e todo nome de tool aparece no array ou no manifesto", async () => {
		const { seen } = await v3({ text: "Bom dia", script: [say("Oi")] });
		const first = seen[0]!;
		expect(first.names).toEqual(expect.arrayContaining(["browser_navigate", "browser_snapshot", "browser_act", "browser_tabs", "sandbox_shell", "login_fill", "tool_search", "tool_call"]));
		for (const name of ["propose_bot", "create_file", "page_create", "propose_routine"]) expect(first.context, name).toMatch(new RegExp(`\\b${name}\\b`));
		// O navegador antigo (ler, achar, esperar, tela, coordenadas) não existe no v3: nem no array nem no manifesto.
		for (const name of ["browser_read", "browser_find", "browser_wait"]) {
			expect(first.names, name).not.toContain(name);
			expect(first.context, name).not.toMatch(new RegExp(`\\b${name}\\b`));
		}
		for (let index = 0; index < 50; index += 1) expect(first.context).toContain(`Servico ${index}`);
	});

	it("3 blocos: um system só (SOUL + idioma), contexto logo depois e o volátil antes da fala; nenhum system no meio", async () => {
		vi.stubEnv("ATLAS_NOW_NOTE", "on");
		const { seen } = await v3({ text: "Qual a previsão de hoje?", script: [tools(call("s1", "web_search", { query: "previsão hoje" })), say("Sol.")] });
		for (const step of seen) {
			expect(step.params.messages.filter((message) => message.role === "system")).toHaveLength(1);
			expect(step.params.messages[0]!.role).toBe("system");
			expect(textOf(step.params.messages[1]!)).toMatch(/^\[context\] /);
		}
		const first = seen[0]!.params.messages;
		expect(textOf(first.at(-2)!)).toMatch(/^\[runtime\] .*Now is /s);
		expect(textOf(first.at(-1)!)).toBe("Qual a previsão de hoje?");
		expect(seen[0]!.system).toContain('You are "Cookie"');
		expect(seen[0]!.system.trim().endsWith(languageInstruction("pt-BR"))).toBe(false); // idioma fixo vai na persona
		expect(seen[0]!.system).toContain(languageInstruction("pt-BR"));
		// O array de tools e o system não mudam entre os passos (prefixo em cache).
		expect(JSON.stringify(seen[1]!.params.tools)).toBe(JSON.stringify(seen[0]!.params.tools));
		expect(seen[1]!.system).toBe(seen[0]!.system);
		vi.unstubAllEnvs();
	});
});

describe("motor v3: ponte tool_search / tool_call", () => {
	it("criar bot com 50 conectores: tool_search acha propose_bot no passo 1 e tool_call o executa pelo nome real", async () => {
		const { seen, results, calls, result } = await v3({
			text: "Cria um bot para cuidar das minhas finanças pessoais",
			script: [
				tools(call("q1", "tool_search", { query: "create a new bot" })),
				(() => tools(call("c1", "tool_call", { name: "propose_bot", args: { name: "Finanças", description: "Cuida das finanças pessoais do dono: gastos, contas e metas." } })))(),
				say("Mandei a proposta."),
			],
		});
		expect(seen[0]!.names).not.toContain("propose_bot");
		expect(results[0]).toMatchObject({ name: "tool_search", ok: true });
		expect(results[0]!.summary.split("\n")[1]).toMatch(/^1\. propose_bot\(/);
		// A política, os eventos e o cartão veem o nome real, não "tool_call".
		expect(calls[1]).toMatchObject({ name: "propose_bot" });
		expect(results[1]).toMatchObject({ name: "propose_bot", ok: true });
		expect(result.stop).toMatchObject({ reason: "awaiting_confirmation" });
	});

	it("tool_call direto pelo manifesto (sem busca) e chamada direta pelo nome rodam sem passo de carga", async () => {
		const viaBridge = await v3({ text: "que horas são?", script: [tools(call("c1", "tool_call", { name: "current_time", args: {} })), say("10h.")] });
		expect(viaBridge.results[0]).toMatchObject({ name: "current_time", ok: true });
		expect(viaBridge.results[0]!.summary).toMatch(/timezone America\/Sao_Paulo/);
		const direct = await v3({ text: "que horas são?", script: [tools(call("d1", "current_time", {})), say("10h.")] });
		expect(direct.results[0]).toMatchObject({ name: "current_time", ok: true });
		expect(direct.seen).toHaveLength(2);
	});

	it("args errados voltam com a assinatura; nome errado volta com os nomes próximos; nada executa", async () => {
		const { results } = await v3({
			text: "cria o bot",
			script: [
				tools(call("a1", "tool_call", { name: "propose_bot", args: { name: 5 } })),
				tools(call("a2", "tool_call", { name: "propose_bots", args: {} })),
				tools(call("a3", "tool_call", { args: {} })),
				say("Não deu."),
			],
		});
		expect(results[0]).toMatchObject({ name: "propose_bot", ok: false });
		expect(results[0]!.summary).toMatch(/^Invalid arguments: missing required description; name must be string\. Expected: propose_bot\(name: string, description: string/);
		expect(results[1]!.summary).toMatch(/^Unknown tool "propose_bots"\. Closest available: propose_bot/);
		expect(results[2]!.summary).toMatch(/^Invalid arguments: missing required name\. Expected: tool_call\(name: string, args\?: object\)/);
	});

	it("tool que a política esconde (rotina, envio) não aparece e tool_call devolve o motivo", async () => {
		const { seen, results } = await v3({
			text: "rotina",
			script: [tools(call("w1", "tool_call", { name: "mcp__svc1__send_message", args: { channel: "c", text: "oi" } })), say("Não posso.")],
			extra: { origin: "routine", humanTurn: false },
		});
		expect(seen[0]!.context).not.toContain("send_message");
		expect(seen[0]!.context).toContain("mcp__svc1__list_items");
		expect(results[0]).toMatchObject({ name: "mcp__svc1__send_message", ok: false });
		expect(results[0]!.summary).toMatch(/^Not available in this run: no human present/);
	});
});

describe("motor v3: catálogo congelado por conversa e núcleo por uso", () => {
	it("conversa nova usa o uso do bot; o turno seguinte (loadedTools) mantém o mesmo array, mesmo com uso diferente", async () => {
		const loadToolUsage = vi.fn(async () => ({ current_time: 4, app_info: 3, create_file: 12 }));
		const first = await v3({ text: "Bom dia", script: [say("Oi")], extra: { loadToolUsage } });
		expect(first.seen[0]!.names).toEqual(expect.arrayContaining(["current_time", "app_info"]));
		// Com a VM o núcleo já está perto do teto: create_file (~3,7 mil caracteres) não cabe e segue no manifesto.
		expect(first.seen[0]!.names).not.toContain("create_file");
		expect(first.seen[0]!.system.length + first.seen[0]!.toolsChars).toBeLessThanOrEqual(20_000);
		const loaded = first.checkpoints.at(-1)!.loadedTools!;
		expect(loaded).toEqual(expect.arrayContaining(["current_time", "app_info"]));
		const changedUsage = vi.fn(async () => ({ page_create: 50 }));
		const next = await v3({ text: "E aí?", script: [say("Oi")], extra: { loadToolUsage: changedUsage, priorLoadedTools: loaded } });
		expect(changedUsage).not.toHaveBeenCalled();
		expect(JSON.stringify(next.seen[0]!.params.tools)).toBe(JSON.stringify(first.seen[0]!.params.tools));
		expect(next.seen[0]!.system).toBe(first.seen[0]!.system);
		expect(next.seen[0]!.context).toBe(first.seen[0]!.context);
	});

	it("o bloco de contexto do run anterior não se repete no histórico; nota system antiga (v2) vira [runtime]", async () => {
		const first = await v3({ text: "Bom dia", script: [say("Oi")] });
		const history = first.checkpoints.at(-1)!.llmMessages!.slice(1) as ComputerUseParams["priorTranscript"];
		const withV2Note = [...history!, { role: "system" as const, content: "nota antiga do v2" }];
		const next = await v3({
			text: "E agora?",
			script: [say("Oi")],
			extra: { messages: [{ role: "system", content: "[[conversation-transcript-slot]]" }, { role: "user", content: "E agora?" }], priorTranscript: withV2Note },
		});
		const messages = next.seen[0]!.params.messages;
		expect(messages.filter((message) => textOf(message).startsWith(CONTEXT_HEADER))).toHaveLength(1);
		expect(messages.filter((message) => message.role === "system")).toHaveLength(1);
		expect(messages.some((message) => message.role === "user" && textOf(message) === "[runtime] nota antiga do v2")).toBe(true);
	});
});

describe("motor v3: filtro de tools do run vale para conector (como no v2)", () => {
	it("brief \"Seu dia\" (só leitura): conector de escrita fora do manifesto e a chamada é recusada sem executar", async () => {
		const mcp = mcpOf(fiftyConnectors);
		const { seen, results } = await v3({
			text: "Seu dia",
			script: [tools(call("w1", "tool_call", { name: "mcp__svc3__send_message", args: { channel: "c", text: "oi" } }), call("w2", "mcp__svc3__create_bot", { name: "x" })), say("Pronto.")],
			extra: { mcp, toolFilter: briefToolFilter(mcp) },
		});
		expect(seen[0]!.context).not.toMatch(/send_message|create_bot|create_page/);
		expect(seen[0]!.context).toMatch(/list_items/);
		expect(results.map((result) => [result.name, result.ok])).toEqual([["mcp__svc3__send_message", false], ["mcp__svc3__create_bot", false]]);
		expect(mcpCall).not.toHaveBeenCalled();
	});

	it("ajudante com filtro: só o que o filtro deixa aparece e roda; o resto é recusado", async () => {
		const allowed = new Set(["web_search", "mcp__svc1__list_items"]);
		const { seen, results } = await v3({
			text: "pesquise",
			script: [tools(call("h1", "tool_call", { name: "mcp__svc2__list_items", args: {} }), call("h2", "mcp__svc1__list_items", {})), say("ok")],
			extra: { toolFilter: (name) => allowed.has(name) },
		});
		expect(seen[0]!.context).toContain("mcp__svc1__list_items");
		expect(seen[0]!.context).not.toContain("svc2");
		expect(results[0]).toMatchObject({ name: "mcp__svc2__list_items", ok: false });
		expect(results[1]).toMatchObject({ name: "mcp__svc1__list_items", ok: true });
		expect(mcpCall).toHaveBeenCalledTimes(1);
	});
});

describe("motor v3: manifesto degradado (modo top) estável entre turnos", () => {
	/** 120 conectores x 6 tools: nem com só os nomes cabe no teto, então cada conector mostra as 5 mais usadas. */
	const many: McpToolsetConnection[] = Array.from({ length: 120 }, (_, index) => ({ ...fiftyConnectors[index % 50]!, id: `big-${index}`, slug: `big${index}`, name: `Grande ${index}` }));
	// Abaixo de 3 chamadas: nada sobe ao núcleo, o uso só ordena o manifesto e desempata a busca.
	const usage = { mcp__big7__send_message: 2, mcp__big7__search: 1, mcp__big9__get_item: 1 };

	it("o uso congelado com o catálogo faz o [context] do turno 2 sair com os mesmos bytes (e a busca com o mesmo desempate)", async () => {
		const first = await v3({ text: "Bom dia", script: [say("Oi")], extra: { mcp: mcpOf(many), loadToolUsage: vi.fn(async () => usage) } });
		const context = first.seen[0]!.context;
		expect(context).toMatch(/only the most used are listed/);
		expect(context).toMatch(/- Grande 7 \(6 tools, prefix mcp__big7__\): send_message, search, /);
		const checkpoint = first.checkpoints.at(-1)!;
		expect((checkpoint.engineV3 as { toolUsage?: unknown }).toolUsage).toEqual(usage);

		// Turno 2: o worker devolve o núcleo (`loadedTools`) e o uso (`engineV3.toolUsage`) do transcript; o uso NÃO é relido.
		const reload = vi.fn(async () => ({ mcp__big1__search: 99 }));
		const next = await v3({
			text: "E aí?",
			script: [tools(call("s1", "tool_search", { query: "send message" })), say("ok")],
			extra: { mcp: mcpOf(many), loadToolUsage: reload, priorLoadedTools: checkpoint.loadedTools, priorToolUsage: (checkpoint.engineV3 as { toolUsage: Record<string, number> }).toolUsage },
		});
		expect(reload).not.toHaveBeenCalled();
		expect(next.seen[0]!.context).toBe(context);
		expect(JSON.stringify(next.seen[0]!.params.tools)).toBe(JSON.stringify(first.seen[0]!.params.tools));
		// Desempate da busca pelo uso congelado: entre 120 send_message de conector, o mais usado vem primeiro.
		expect(next.results[0]!.summary.split("\n")[1]).toMatch(/^1\. mcp__big7__send_message\(/);
	});
});
