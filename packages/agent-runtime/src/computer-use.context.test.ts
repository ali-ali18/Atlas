import type { JevRuntime } from "./jev/decide.js";
import { WANTS_FILE_JEV } from "./jev/test-support.js";
import { describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { ChatTool, CompleteChatWithToolsResult, LlmMessage, LlmToolCall } from "@workspace/llm";
import type { AgentRunCheckpoint } from "@workspace/shared";
import { runComputerUse } from "./computer-use.js";
import { buildMcpToolset } from "./mcp/registry.js";
import { parseRuntimeCheckpoint } from "./checkpoint.js";

/** Artefatos em memória com o contrato de dono do db: só o dono lê. */
const artifactRows = vi.hoisted(() => new Map<string, { owner: string; runId: string; kind: string; bytes: Uint8Array }>());

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	persistUserArtifact: vi.fn(async (input: { userId: string; runId: string; kind: string; bytes: Uint8Array }) => {
		const id = `art-${artifactRows.size + 1}`;
		artifactRows.set(id, { owner: input.userId, runId: input.runId, kind: input.kind, bytes: input.bytes });
		return { id };
	}),
	loadArtifactForUser: vi.fn(async (id: string, userId: string) => {
		const row = artifactRows.get(id);
		return row && row.owner === userId ? row : null;
	}),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

const done: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "Done." } };
const call = (id: string, name: string, args: Record<string, unknown>): LlmToolCall => ({
	id,
	type: "function",
	function: { name, arguments: JSON.stringify(args) },
});
const turn = (...calls: LlmToolCall[]): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: calls },
});

type Request = { tools: ChatTool[]; messages: LlmMessage[] };

async function run(input: {
	message: string;
	economy: boolean;
	script?: CompleteChatWithToolsResult[];
	sandbox?: boolean;
	mcp?: Parameters<typeof runComputerUse>[0]["mcp"];
	restoredCheckpoint?: AgentRunCheckpoint | null;
	onCheckpoint?: (checkpoint: AgentRunCheckpoint) => void;
	userImageArtifactIds?: string[];
	jev?: JevRuntime;
}) {
	const requests: Request[] = [];
	const results: Array<{ name: string; ok: boolean; summary: string }> = [];
	let decision = 0;
	const script = input.script ?? [done];
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		sandboxEnabled: input.sandbox ?? true,
		apiKey: "test",
		model: "m",
		runId: "run-ctx",
		userId: "user-a",
		botId: "bot-a",
		origin: "chat",
		contextEconomy: input.economy,
		jev: input.jev,
		messages: [{ role: "user", content: input.message }],
		mcp: input.mcp,
		restoredCheckpoint: input.restoredCheckpoint ?? null,
		userImageArtifactIds: input.userImageArtifactIds,
		maxSteps: 8,
		onEvent: (event) => {
			if (event.type === "tool_result") results.push({ name: event.name, ok: event.ok, summary: event.summary });
		},
		onCheckpoint: input.onCheckpoint ? async (checkpoint) => input.onCheckpoint?.(checkpoint) : undefined,
		streamChat: async (params) => {
			requests.push({
				tools: JSON.parse(JSON.stringify(params.tools)) as ChatTool[],
				messages: JSON.parse(JSON.stringify(params.messages)) as LlmMessage[],
			});
			return script[Math.min(decision++, script.length - 1)]!;
		},
	});
	return { requests, results };
}

const names = (request: Request) => request.tools.map((tool) => tool.function.name);
const systemOf = (request: Request) => String(request.messages[0]!.content);
/** Bytes que o provedor recebe antes das mensagens de conversa: tools + prompt de sistema. */
const fixedPrefix = (request: Request) => JSON.stringify(request.tools) + systemOf(request);
const estimatedTokens = (chars: number) => Math.round(chars / 4);

describe("L5: prefixo fixo da 1ª decisão", () => {
	it("mede o pedido do 'Bom dia' antes e depois (tools + prompt de sistema)", async () => {
		const before = (await run({ message: "Bom dia", economy: false })).requests[0]!;
		const after = (await run({ message: "Bom dia", economy: true })).requests[0]!;
		const beforeChars = fixedPrefix(before).length;
		const afterChars = fixedPrefix(after).length;
		// eslint-disable-next-line no-console
		console.info(
			`[L5] 1ª decisão "Bom dia": antes ${beforeChars} chars (~${estimatedTokens(beforeChars)} tokens, ${before.tools.length} tools), ` +
				`depois ${afterChars} chars (~${estimatedTokens(afterChars)} tokens, ${after.tools.length} tools), ` +
				`economia ~${estimatedTokens(beforeChars - afterChars)} tokens`,
		);
		// Meta do plano: -6k a -8k tokens na 1ª decisão (4 chars por token).
		expect(estimatedTokens(beforeChars - afterChars)).toBeGreaterThanOrEqual(6_000);
		// 0,55 (era 0,52): `memory` virou núcleo e o schema dela entra no prefixo de todo chat.
		expect(afterChars).toBeLessThan(beforeChars * 0.55);
		expect(names(after)).toContain("memory");
		// O núcleo continua inteiro: pesquisa, delegação e a busca que carrega o resto.
		expect(names(after)).toEqual(expect.arrayContaining(["web_search", "web_extract", "mcp_tool_search"]));
		// `propose_questionnaire` é núcleo: vai sempre.
		expect(names(after)).toContain("propose_questionnaire");
		// As raras ficaram de fora e estão no índice do prompt.
		for (const rare of ["propose_routine", "memory_search", "create_file", "click"]) {
			expect(names(after)).not.toContain(rare);
			expect(systemOf(after)).toContain(rare);
		}
		// V6: com sandbox o grupo browser (<= 8 tools) já vai no 1º passo, sem passar por mcp_tool_search; o desktop fica sob demanda.
		const browserTools = ["navigate", "browser_read", "browser_find", "browser_snapshot", "browser_act", "browser_wait", "screenshot"];
		expect(names(after)).toEqual(expect.arrayContaining(browserTools));
		expect(names(after).filter((name) => /^(navigate|screenshot|browser_.*)$/.test(name)).length).toBeLessThanOrEqual(8);
		for (const gone of ["browser_click", "browser_type", "browser_text", "browser_links"]) expect(names(after)).not.toContain(gone);
		expect(systemOf(after)).not.toContain("browser: navigate");
		expect(systemOf(after)).toContain("mcp_tool_search");
		// `skill_read` é núcleo: nunca fica adiada.
		expect(names(after)).toContain("skill_read");
	});

	it("com conector pequeno e conector grande o ganho se mantém", async () => {
		const small = buildMcpToolset([
			{
				id: "c1",
				slug: "data",
				name: "Data",
				disabledTools: [],
				tools: [{ name: "search", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }],
			},
		]);
		const mcp = { toolset: small, call: async () => ({ ok: true, text: "x", truncated: false }) };
		const before = (await run({ message: "Bom dia", economy: false, mcp })).requests[0]!;
		const after = (await run({ message: "Bom dia", economy: true, mcp })).requests[0]!;
		expect(fixedPrefix(after).length).toBeLessThan(fixedPrefix(before).length * 0.55);
		expect(names(after)).toContain("mcp__data__search");
	});

	it("pedido de rotina carrega as tools e o procedimento já na 1ª decisão (sem passo extra)", async () => {
		const request = (await run({ message: "me lembra dia 03/10 às 10h e 20h de tomar o remédio", economy: true })).requests[0]!;
		expect(names(request)).toEqual(expect.arrayContaining(["propose_routine", "list_routines"]));
		expect(systemOf(request)).toContain("Lembretes:");
		// Fica no fim do array: o núcleo continua sendo prefixo exato.
		const core = names((await run({ message: "Bom dia", economy: true })).requests[0]!);
		expect(names(request).slice(0, core.length)).toEqual(core);
	});

	it("pedido de site traz navegador, imagens e a escada de pesquisa", async () => {
		const request = (await run({ message: "abre https://example.com e me diz o título", economy: true })).requests[0]!;
		expect(names(request)).toEqual(expect.arrayContaining(["browser_snapshot", "browser_act", "navigate", "show_image"]));
		expect(systemOf(request)).toContain("Browser (web pages in the VM browser)");
	});

	it("sem sandbox as tools de navegador nem entram no índice", async () => {
		const request = (await run({ message: "Bom dia", economy: true, sandbox: false })).requests[0]!;
		expect(systemOf(request)).not.toContain("browser_snapshot");
	});
});

describe("L5/L4: prefixo byte-estável", () => {
	it("dois runs do mesmo bot/config geram os mesmos bytes (tools + prompt), mesmo com pedidos diferentes sem intenção", async () => {
		const a = (await run({ message: "Bom dia", economy: true })).requests[0]!;
		const b = (await run({ message: "Qual é a capital da França?", economy: true })).requests[0]!;
		expect(fixedPrefix(a)).toBe(fixedPrefix(b));
		const c = (await run({ message: "Bom dia", economy: true })).requests[0]!;
		expect(fixedPrefix(a)).toBe(fixedPrefix(c));
	});

	it("o núcleo do prompt é prefixo do prompt de qualquer intenção", async () => {
		const plain = systemOf((await run({ message: "Bom dia", economy: true })).requests[0]!);
		const routine = systemOf((await run({ message: "cria uma rotina diária", economy: true })).requests[0]!);
		const core = plain.slice(0, plain.indexOf("Built-in tools loaded on demand"));
		expect(core.length).toBeGreaterThan(1_000);
		expect(routine.startsWith(core)).toBe(true);
	});

	it("a ordem das tools de conector não depende da ordem do banco", async () => {
		const tool = (name: string) => ({ name, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } });
		const build = (order: string[]) =>
			buildMcpToolset(order.map((slug) => ({ id: slug, slug, name: slug, disabledTools: [], tools: [tool("read")] })));
		const call = async () => ({ ok: true, text: "x", truncated: false });
		const a = (await run({ message: "Bom dia", economy: true, mcp: { toolset: build(["alpha", "beta"]), call } })).requests[0]!;
		const b = (await run({ message: "Bom dia", economy: true, mcp: { toolset: build(["beta", "alpha"]), call } })).requests[0]!;
		expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
	});
});

describe("L5: tool nativa adiada é achada e carregada", () => {
	it("mcp_tool_search carrega o grupo; a tool entra no FIM do array e o resto não se mexe", async () => {
		const { requests, results } = await run({
			message: "Do the work.",
			economy: true,
			script: [turn(call("s1", "mcp_tool_search", { query: "set a reminder routine" })), done],
		});
		expect(names(requests[0]!)).not.toContain("propose_routine");
		const second = names(requests[1]!);
		expect(second).toContain("propose_routine");
		// Prefixo estável: o array do 1º passo é prefixo exato do 2º.
		expect(second.slice(0, names(requests[0]!).length)).toEqual(names(requests[0]!));
		expect(second.slice(names(requests[0]!).length)).toEqual(["list_routines", "propose_routine", "routine_group", "routine_control", "github_list_repos"]);
		expect(results[0]).toMatchObject({ name: "mcp_tool_search", ok: true });
		// O procedimento que não estava no prompt vem junto do resultado.
		expect(results[0]!.summary).toContain("Loaded built-in tools");
		expect(results[0]!.summary).toContain("Lembretes:");
	});

	it("busca por nome exato carrega só aquela tool", async () => {
		const { requests } = await run({
			message: "Do the work.",
			economy: true,
			script: [turn(call("s1", "mcp_tool_search", { query: "create_file" })), done],
		});
		expect(names(requests[1]!).slice(names(requests[0]!).length)).toEqual(["create_file"]);
	});

	it("busca sem resultado lista o que ainda dá para carregar (sem sucesso falso)", async () => {
		const { results } = await run({
			message: "Do the work.",
			economy: true,
			script: [turn(call("s1", "mcp_tool_search", { query: "zzzz qqqq" })), done],
		});
		expect(results[0]!.summary).toContain('No built-in tool matches "zzzz qqqq"');
		expect(results[0]!.summary).toContain("propose_routine");
	});

	it("L19: chamar direto uma tool adiada não executa, carrega o grupo e o modelo repete com o schema", async () => {
		const { requests, results } = await run({
			message: "Do the work.",
			economy: true,
			script: [turn(call("d1", "list_routines", {})), done],
		});
		expect(results[0]).toMatchObject({ name: "list_routines", ok: false });
		expect(results[0]!.summary).toContain("was not loaded");
		expect(results[0]!.summary).toContain("mcp_tool_search");
		expect(names(requests[1]!)).toContain("list_routines");
		expect(names(requests[1]!)).toContain("propose_routine");
	});

	it("tool que nem é elegível (subagente/tool desconhecida) segue recusada pela mensagem de sempre", async () => {
		const { results } = await run({
			message: "Do the work.",
			economy: true,
			script: [turn(call("d1", "not_a_tool", {})), done],
		});
		expect(results[0]).toMatchObject({ ok: false });
		expect(results[0]!.summary).toContain("not available");
	});

	it("com conector: consulta de conector não é sequestrada por palavra solta, nome de grupo carrega as duas", async () => {
		const toolset = buildMcpToolset(
			[
				{
					id: "c1",
					slug: "shop",
					name: "Shop",
					disabledTools: [],
					tools: Array.from({ length: 41 }, (_, i) => ({
						name: i === 0 ? "list_items" : `tool_${i}`,
						inputSchema: { type: "object", properties: {} },
						annotations: { readOnlyHint: true },
					})),
				},
			],
			{ maxTools: 5 },
		);
		expect(toolset.deferred).toBe(true);
		const mcp = { toolset, call: async () => ({ ok: true, text: "x", truncated: false }) };
		const { requests, results } = await run({
			message: "Do the work.",
			economy: true,
			mcp,
			script: [turn(call("s1", "mcp_tool_search", { query: "list items" })), turn(call("s2", "mcp_tool_search", { query: "routines list_items" })), done],
		});
		expect(results[0]!.summary).not.toContain("Loaded built-in tools");
		expect(names(requests[1]!)).toContain("mcp__shop__list_items");
		expect(names(requests[1]!)).not.toContain("propose_routine");
		expect(results[1]!.summary).toContain("Loaded built-in tools");
		expect(names(requests[2]!)).toContain("propose_routine");
		// L4: tool carregada no meio (conector ou nativa) só acrescenta ao fim; nada reordena.
		expect(names(requests[1]!).slice(0, names(requests[0]!).length)).toEqual(names(requests[0]!));
		expect(names(requests[2]!).slice(0, names(requests[1]!).length)).toEqual(names(requests[1]!));
	});

	it("retomada: tool nativa carregada antes da pausa volta ao conjunto", async () => {
		let stored: AgentRunCheckpoint | undefined;
		await run({
			message: "Do the work.",
			economy: true,
			script: [turn(call("s1", "mcp_tool_search", { query: "create_file" })), done],
			onCheckpoint: (checkpoint) => {
				stored = checkpoint;
			},
		});
		const resumed = await run({
			message: "Do the work.",
			economy: true,
			restoredCheckpoint: parseRuntimeCheckpoint(JSON.parse(JSON.stringify(stored))),
		});
		expect(names(resumed.requests[0]!)).toContain("create_file");
	});

	it("pedido de arquivo (Jev) continua exigindo o arquivo mesmo com create_file adiada", async () => {
		const { requests } = await run({
			message: "Fais-moi un rapport PDF",
			jev: WANTS_FILE_JEV,
			economy: true,
			script: [{ model: "m", message: { role: "assistant", content: "I'll create the PDF report now." }, finishReason: "stop" }, done],
		});
		expect(requests.length).toBeGreaterThan(1);
	});
});

describe("L5: flag desligada restaura o comportamento anterior", () => {
	it("contextEconomy:false envia todas as tools na ordem de sempre e o prompt inteiro", async () => {
		const request = (await run({ message: "Bom dia", economy: false })).requests[0]!;
		expect(names(request)).toEqual(expect.arrayContaining(["propose_routine", "memory", "create_file", "browser_snapshot"]));
		expect(systemOf(request)).toContain("Lembretes:");
		expect(systemOf(request)).not.toContain("Built-in tools loaded on demand");
	});
});

describe("L3: resultado grande por referência (contexto + artifact_read)", () => {
	const big = Array.from({ length: 3_000 }, (_, i) => `row-${i} payload-${i}`).join(" ");
	const toolset = buildMcpToolset([
		{
			id: "c1",
			slug: "data",
			name: "Data",
			disabledTools: [],
			tools: [{ name: "dump", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }],
		},
	]);
	const mcp = { toolset, call: async () => ({ ok: true, text: big, truncated: false }) };
	const toolTexts = (request: Request) => request.messages.filter((m) => m.role === "tool").map((m) => String(m.content));

	it("o contexto guarda o stub com o id; o texto inteiro está no artefato; artifact_read relê", async () => {
		artifactRows.clear();
		const { requests, results } = await run({
			message: "Do the work.",
			economy: true,
			mcp,
			script: [
				turn(call("d1", "mcp__data__dump", {})),
				turn(call("r1", "artifact_read", { id: "art-1", find: "row-2500 " })),
				done,
			],
		});
		const stub = toolTexts(requests[1]!)[0]!;
		expect(stub.length).toBeLessThan(big.length / 4);
		expect(stub).toContain("artifact:art-1");
		const stored = new TextDecoder().decode(artifactRows.get("art-1")!.bytes);
		expect(stored.length).toBeGreaterThan(20_000);
		expect(stub).toContain(`${stored.length} characters`);
		expect(stub).not.toContain("row-2500 ");
		expect(stored).toContain("row-0 payload-0");
		// A tool de leitura foi carregada junto do stub e acrescentada ao fim.
		expect(names(requests[1]!)).toContain("artifact_read");
		expect(names(requests[1]!).slice(0, names(requests[0]!).length)).toEqual(names(requests[0]!));
		expect(results[1]).toMatchObject({ name: "artifact_read", ok: true });
		expect(results[1]!.summary).toContain("row-2500 payload-2500");
	});

	it("artefato de outro usuário não é lido pelo run (ok:false, sem vazar)", async () => {
		artifactRows.clear();
		artifactRows.set("art-9", { owner: "user-b", runId: "run-ctx", kind: "tool_result", bytes: new TextEncoder().encode("segredo do B") });
		const { results } = await run({
			message: "Do the work.",
			economy: true,
			script: [turn(call("m1", "mcp_tool_search", { query: "artifact_read" })), turn(call("r1", "artifact_read", { id: "art-9" })), done],
		});
		expect(results[1]).toMatchObject({ name: "artifact_read", ok: false });
		expect(results[1]!.summary).toContain("Stored result not found");
		expect(results[1]!.summary).not.toContain("segredo");
	});

	it("com a economia desligada nada é guardado e o resultado segue inteiro", async () => {
		artifactRows.clear();
		const { requests } = await run({
			message: "Do the work.",
			economy: false,
			mcp,
			script: [turn(call("d1", "mcp__data__dump", {})), done],
		});
		expect(artifactRows.size).toBe(0);
		expect(toolTexts(requests[1]!)[0]!.length).toBeGreaterThan(20_000);
	});
});

describe("L14: orçamento de contexto no run", () => {
	it("com teto pequeno o pedido ao modelo para de crescer e a nota guarda o objetivo", async () => {
		const toolset = buildMcpToolset([
			{
				id: "c1",
				slug: "data",
				name: "Data",
				disabledTools: [],
				tools: [{ name: "read", inputSchema: { type: "object", properties: { n: { type: "integer" } } }, annotations: { readOnlyHint: true } }],
			},
		]);
		const mcp = { toolset, call: async (_name: string, args: Record<string, unknown>) => ({ ok: true, text: `payload ${args.n} `.repeat(150), truncated: false }) };
		const script = [
			...Array.from({ length: 14 }, (_, i) => turn(call(`r${i}`, "mcp__data__read", { n: i }))),
			done,
		];
		const requests: Request[] = [];
		let decision = 0;
		await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => "unused",
			sandboxEnabled: false,
			apiKey: "test",
			model: "m",
			runId: "run-budget",
			userId: "user-a",
			origin: "chat",
			contextEconomy: true,
			contextBudget: { targetTokens: 2_500, ceilingTokens: 4_000 },
			objective: "Summarize the quarterly numbers.",
			messages: [{ role: "user", content: "Summarize the quarterly numbers." }],
			mcp,
			maxSteps: 30,
			onEvent: () => undefined,
			streamChat: async (params) => {
				requests.push({ tools: params.tools, messages: JSON.parse(JSON.stringify(params.messages)) as LlmMessage[] });
				return script[Math.min(decision++, script.length - 1)]!;
			},
		});
		const size = (request: Request) => JSON.stringify(request.messages).length;
		const last = requests.at(-1)!;
		const notes = last.messages.filter((m) => String(m.content).startsWith("[Operational context compacted]"));
		expect(notes).toHaveLength(1);
		expect(String(notes[0]!.content)).toContain("Objective: Summarize the quarterly numbers.");
		// Sem o orçamento o último pedido teria ~14 resultados inteiros (~19k chars); com ele fica no teto.
		// O system prompt é prefixo fixo (não compactável) e cresce com regras novas: mede só o resto.
		const prefix = (request: Request) => String(request.messages[0]?.role === "system" ? request.messages[0].content : "").length;
		const variable = (request: Request) => size(request) - prefix(request);
		expect(variable(last)).toBeLessThan(4_000 * 4 * 0.5);
		expect(Math.max(...requests.map(variable))).toBeLessThan(4_000 * 4 * 0.6);
	});
});

describe("Padrão: resumo por modelo no run", () => {
	const toolset = buildMcpToolset([
		{
			id: "c1",
			slug: "data",
			name: "Data",
			disabledTools: [],
			tools: [{ name: "read", inputSchema: { type: "object", properties: { n: { type: "integer" } } }, annotations: { readOnlyHint: true } }],
		},
	]);
	const mcp = { toolset, call: async (_name: string, args: Record<string, unknown>) => ({ ok: true, text: `payload ${args.n} `.repeat(600), truncated: false }) };
	const SUMMARY = "Objective: summarize the quarterly numbers. Done: read 14 sources. Open: write the final answer.";

	async function runWithBudget(contextBudget: NonNullable<Parameters<typeof runComputerUse>[0]["contextBudget"]>, summaryReply: "ok" | "fail") {
		const script = [...Array.from({ length: 14 }, (_, i) => turn(call(`r${i}`, "mcp__data__read", { n: i }))), done];
		const requests: Request[] = [];
		const events: Array<{ type: string; before?: number; after?: number }> = [];
		const steps: Array<{ subIndex: number; costUsd?: number; tokens?: number }> = [];
		let summaryCalls = 0;
		let decision = 0;
		const result = await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => "unused",
			sandboxEnabled: false,
			apiKey: "test",
			model: "m",
			messageTriageModel: "maint/model",
			runId: "run-summary",
			userId: "user-a",
			origin: "chat",
			contextEconomy: true,
			contextBudget,
			objective: "Summarize the quarterly numbers.",
			messages: [{ role: "user", content: "Summarize the quarterly numbers." }],
			mcp,
			maxSteps: 30,
			onStep: async (step) => {
				if (step.subIndex === 97) steps.push(step);
			},
			onEvent: (event) => {
				if (event.type === "context_compacted") events.push(event);
			},
			streamChat: async (params) => {
				if (params.model === "maint/model" && params.tools.length === 0 && params.toolChoice === "none") {
					summaryCalls += 1;
					if (summaryReply === "fail") throw new Error("provider down");
					return { model: "maint/model", message: { role: "assistant", content: SUMMARY }, usage: { promptTokens: 900, completionTokens: 120, totalTokens: 1020, costUsd: 0.0007 } };
				}
				requests.push({ tools: params.tools, messages: JSON.parse(JSON.stringify(params.messages)) as LlmMessage[] });
				return script[Math.min(decision++, script.length - 1)]!;
			},
		});
		return { requests, events, summaryCalls, result, steps };
	}

	it("passando do teto, a parte antiga vira resumo (uma vez por gatilho), o aviso sai e o custo entra no run", async () => {
		const { requests, events, summaryCalls, result, steps } = await runWithBudget({ targetTokens: 12_500, ceilingTokens: 13_000, keepSteps: [6, 4], summarize: true }, "ok");
		// Cada resumo vira uma linha com tokens e custo para as telas de custo.
		expect(steps).toHaveLength(summaryCalls);
		expect(steps[0]).toMatchObject({ costUsd: 0.0007, tokens: 1020 });
		expect(summaryCalls).toBeGreaterThanOrEqual(1);
		expect(summaryCalls).toBeLessThan(requests.length / 2);
		const last = requests.at(-1)!;
		const summaries = last.messages.filter((m) => String(m.content).startsWith("[Conversation summary]"));
		expect(summaries).toHaveLength(1);
		expect(String(summaries[0]!.content)).toContain(SUMMARY);
		expect(events.length).toBeLessThanOrEqual(summaryCalls);
		expect(result.usage.costUsd ?? 0).toBeGreaterThanOrEqual(0.0007 * summaryCalls);
	});

	it("resumo que falha cai na poda de sempre, sem derrubar o run", async () => {
		const { requests, events, summaryCalls } = await runWithBudget({ targetTokens: 12_500, ceilingTokens: 13_000, keepSteps: [6, 4], summarize: true }, "fail");
		expect(summaryCalls).toBeGreaterThanOrEqual(1);
		// Plano B ativo e sem insistir a cada passo.
		expect(summaryCalls).toBeLessThan(requests.length);
		expect(events).toHaveLength(0);
		const last = requests.at(-1)!;
		expect(last.messages.filter((m) => String(m.content).startsWith("[Operational context compacted]"))).toHaveLength(1);
	});

	it("Econômico: poda direta, o modelo de manutenção nunca é chamado e nenhum aviso sai", async () => {
		const { requests, events, summaryCalls } = await runWithBudget({ targetTokens: 2_500, ceilingTokens: 4_000 }, "ok");
		expect(summaryCalls).toBe(0);
		expect(events).toHaveLength(0);
		expect(requests.at(-1)!.messages.filter((m) => String(m.content).startsWith("[Operational context compacted]"))).toHaveLength(1);
	});
});
