import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { AgentBudgetPolicy } from "./budget.js";
import { runComputerUse } from "./computer-use.js";
import { BudgetExhaustedError } from "./errors.js";
import {
	DELIVERABLE_RESERVE_NOTE,
	DELIVERABLE_RESTRICT_NOTE,
	DELIVERABLE_STAGNATION_NOTE,
	FILE_RESERVE_TOOLS,
	STUCK_ANSWER_NOW_NOTE,
} from "./execution/run-governor.js";
import { STAGNATION_NUDGE_CHANGE_APPROACH } from "./execution/stagnation.js";
import type { JevAsk, JevRuntime } from "./jev/decide.js";
import { jevSaying, WANTS_FILE_JEV } from "./jev/test-support.js";
import { buildMcpToolset } from "./mcp/registry.js";
import type { McpRuntime } from "./mcp/runtime.js";

/**
 * A3 — governo por progresso: custo por execução, reserva de entregável,
 * extensão só com novidade e guarda de releitura. LLM e Jev mockados.
 */

const artifactRows = vi.hoisted(() => new Map<string, { owner: string; runId: string; kind: string; bytes: Uint8Array }>());

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	persistUserArtifact: vi.fn(async (input: { userId: string; runId: string; kind: string; bytes: Uint8Array; mime: string; meta?: object }) => {
		const id = `art-${artifactRows.size + 1}`;
		artifactRows.set(id, { owner: input.userId, runId: input.runId, kind: input.kind, bytes: input.bytes });
		return {
			id,
			kind: input.kind,
			meta: { ...input.meta, mime: input.mime, size: input.bytes.byteLength },
			runId: input.runId,
			conversationId: "conv-gov",
			createdAt: new Date(),
		};
	}),
	loadArtifactForUser: vi.fn(async (id: string, userId: string) => {
		const row = artifactRows.get(id);
		return row && row.owner === userId ? row : null;
	}),
	nextFileVersion: vi.fn(async () => 1),
	countRunFileArtifacts: vi.fn(async () => 0),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	persistJevStatusCard: vi.fn(async () => undefined),
}));

const call = (id: string, name: string, args: Record<string, unknown> = {}): LlmToolCall => ({
	id,
	type: "function",
	function: { name, arguments: JSON.stringify(args) },
});
const turn = (...calls: LlmToolCall[]): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: calls },
});
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content } });

const READ_TOOLS = ["mcp__data__dump_a", "mcp__data__dump_b", "mcp__data__dump_c"];
const toolset = buildMcpToolset(
	[
		{
			id: "c1",
			slug: "data",
			name: "Data",
			disabledTools: [],
			tools: ["dump_a", "dump_b", "dump_c"].map((name) => ({
				name,
				inputSchema: { type: "object", properties: {} },
				annotations: { readOnlyHint: true },
			})),
		},
	],
	{},
);

/** Texto único por chamada (letras, porque o hash ignora dígitos). */
const uniqueText = (n: number) => `página ${n.toString(26).replace(/[0-9]/g, (digit) => "qrstuvwxyz"[Number(digit)] ?? "k")} do assunto pesquisado`;

type Request = { index: number; offered: string[]; toolChoice: string; notes: string[]; messages: CompleteChatWithToolsParams["messages"] };
type Ev = Record<string, unknown> & { type: string };
type Driver = (ctx: { index: number; offered: string[]; toolChoice: string; messages: CompleteChatWithToolsParams["messages"]; events: Ev[] }) => CompleteChatWithToolsResult;

async function run(input: {
	message: string;
	driver: Driver;
	budget?: AgentBudgetPolicy;
	maxSteps?: number;
	economy?: boolean;
	jev?: JevRuntime;
	mcpText?: (n: number) => string;
	costOf?: (index: number) => number;
}) {
	const requests: Request[] = [];
	const events: Array<Record<string, unknown> & { type: string }> = [];
	let decision = 0;
	let mcpCalls = 0;
	const mcp: McpRuntime = {
		toolset,
		call: vi.fn(async () => ({ ok: true, text: (input.mcpText ?? uniqueText)(mcpCalls++), truncated: false })) as unknown as McpRuntime["call"],
	};
	let result: Awaited<ReturnType<typeof runComputerUse>> | undefined;
	let error: unknown;
	try {
		result = await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => "unused",
			sandboxEnabled: false,
			apiKey: "test",
			model: "m",
			runId: "run-gov",
			userId: "user-a",
			botId: "bot-a",
			conversationId: "conv-gov",
			origin: "chat",
			contextEconomy: input.economy ?? false,
			messages: [{ role: "user", content: input.message }],
			maxSteps: input.maxSteps ?? 300,
			budget: input.budget,
			mcp,
			jev: input.jev,
			onEvent: (event) => {
				events.push(event as never);
			},
			streamChat: async (params) => {
				const last = params.messages[params.messages.length - 1];
				// Avaliação do limite brando: o modelo diz que ainda não concluiu.
				if (params.toolChoice === "none" && typeof last?.content === "string" && last.content.includes("AVALIAÇÃO DE PROGRESSO")) {
					return say('{"concluded": false, "summary": "", "continueReason": "mais fontes"}');
				}
				const offered = params.tools.map((tool) => tool.function.name);
				const messages = JSON.parse(JSON.stringify(params.messages)) as CompleteChatWithToolsParams["messages"];
				const index = decision;
				decision += 1;
				requests.push({
					index,
					offered,
					toolChoice: String(params.toolChoice),
					notes: messages.filter((m) => m.role === "system" && typeof m.content === "string").map((m) => String(m.content)),
					messages,
				});
				const next = input.driver({ index, offered, toolChoice: String(params.toolChoice), messages, events });
				const costUsd = input.costOf?.(index);
				return costUsd === undefined ? next : { ...next, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd } };
			},
		});
	} catch (caught) {
		error = caught;
	}
	return { result, error, requests, events, mcp };
}

const rotate = (index: number) => READ_TOOLS[index % READ_TOOLS.length]!;
/** Args únicos por chamada: o cache de leitura do run não pode devolver a página antiga. */
const read = (index: number) => call(`r${index}`, rotate(index), { page: index });
const fileCall = (id: string) => call(id, "create_file", { filename: "relatorio.md", content: "# Relatório\n\nO que deu para levantar.\n\n## Lacunas\n\nFontes não lidas." });
const toolResults = (events: Array<Record<string, unknown> & { type: string }>) => events.filter((event) => event.type === "tool_result");
const fileEvents = (events: Array<Record<string, unknown> & { type: string }>) => events.filter((event) => event.type === "file");
const onlyFileTools = (offered: string[]) => offered.length > 0 && offered.every((name) => FILE_RESERVE_TOOLS.includes(name));

describe("A3: continuação governada por progresso", () => {
	it("run produtivo (novidade a cada passo) passa de 100 decisões e conclui", async () => {
		const { result, error, requests, events } = await run({
			message: "pesquise a fundo o assunto",
			driver: ({ index }) => (index < 110 ? turn(read(index)) : say("Done.")),
		});
		expect(error).toBeUndefined();
		expect(result?.text).toBe("Done.");
		expect(toolResults(events).filter((event) => READ_TOOLS.includes(String(event.name)))).toHaveLength(110);
		expect(requests.length).toBeGreaterThan(110);
	});

	it("loop sem novidade fecha cedo: avisos, depois responde sem tools", async () => {
		const { result, error, requests } = await run({
			message: "pesquise a fundo o assunto",
			mcpText: () => "a mesma página de sempre",
			driver: ({ index, toolChoice }) => (toolChoice === "none" ? say("Resumo com o que consegui.") : turn(read(index))),
		});
		expect(error).toBeUndefined();
		expect(result?.text).toBe("Resumo com o que consegui.");
		const closing = requests.find((request) => request.toolChoice === "none")!;
		expect(closing.index).toBeLessThanOrEqual(8);
		expect(closing.notes).toContain(STAGNATION_NUDGE_CHANGE_APPROACH);
		expect(requests.at(-1)?.index).toBe(closing.index);
	});

	it("arquivo pendente + só leituras: o limite brando não estende e o run passa a produzir o arquivo", async () => {
		const { result, error, requests, events } = await run({
			message: "gera um pdf completo sobre o assunto",
			jev: WANTS_FILE_JEV,
			maxSteps: 80,
			driver: ({ index, offered, events: seen }) => {
				if (fileEvents(seen).length > 0) return say("Pronto.");
				if (onlyFileTools(offered)) return turn(fileCall(`f${index}`));
				return turn(read(index));
			},
		});
		expect(error).toBeUndefined();
		// Na decisão 24 o limite brando é avaliado; com leituras novas mas arquivo pendente, não estende.
		expect(requests[23]!.offered).toEqual(expect.arrayContaining(READ_TOOLS));
		expect(onlyFileTools(requests[24]!.offered)).toBe(true);
		expect(requests[24]!.notes).toContain(DELIVERABLE_STAGNATION_NOTE);
		expect(fileEvents(events)).toHaveLength(1);
		expect(result?.text).toBe("Pronto.");
	});
});

describe("A3: teto de custo e reserva de entregável", () => {
	const costOf = (index: number) => (index < 7 ? 0.125 : index === 7 ? 0.05 : 0.01);

	it("80% avisa, 90% restringe às tools de arquivo, o arquivo sai e o run conclui", async () => {
		let fileIssued = false;
		const { result, error, requests, events } = await run({
			message: "pesquisa e faz um relatório em pdf sobre o assunto",
			jev: WANTS_FILE_JEV,
			budget: { maxCostUsd: 1 },
			costOf,
			driver: ({ index, offered }) => {
				if (fileIssued) return say("Pronto: o relatório foi criado.");
				if (onlyFileTools(offered)) {
					fileIssued = true;
					return turn(fileCall(`f${index}`));
				}
				return turn(read(index));
			},
		});
		expect(error).toBeUndefined();
		expect(requests[6]!.notes).not.toContain(DELIVERABLE_RESERVE_NOTE);
		// 7 decisões custaram 0,875 de 1,00: aviso, sem restringir.
		expect(requests[7]!.notes).toContain(DELIVERABLE_RESERVE_NOTE);
		expect(requests[7]!.offered).toEqual(expect.arrayContaining(READ_TOOLS));
		// 0,925: só as tools de arquivo, com a instrução repetida.
		expect(onlyFileTools(requests[8]!.offered)).toBe(true);
		expect(requests[8]!.offered).toContain("create_file");
		expect(requests[8]!.notes).toContain(DELIVERABLE_RESTRICT_NOTE);
		expect(fileEvents(events)).toHaveLength(1);
		// Com o arquivo entregue, as tools voltam e o run termina normalmente.
		expect(requests[9]!.offered).toEqual(expect.arrayContaining(READ_TOOLS));
		expect(result?.text).toBe("Pronto: o relatório foi criado.");
	});

	it("sem Jev, o pedido de arquivo não gera expectativa: a reserva não mexe nas tools (impacto documentado)", async () => {
		const { error, requests } = await run({
			message: "pesquisa e faz um relatório em pdf sobre o assunto",
			budget: { maxCostUsd: 1 },
			costOf,
			driver: ({ index }) => (index < 9 ? turn(read(index)) : say("Feito.")),
		});
		expect(error).toBeUndefined();
		expect(requests.flatMap((request) => request.notes)).not.toContain(DELIVERABLE_RESERVE_NOTE);
		expect(requests.every((request) => request.offered.some((name) => READ_TOOLS.includes(name)))).toBe(true);
	});

	it("sem arquivo pedido, a reserva não mexe nas tools", async () => {
		const { error, requests } = await run({
			message: "pesquise o assunto",
			jev: jevSaying({}),
			budget: { maxCostUsd: 1 },
			costOf,
			driver: ({ index }) => (index < 9 ? turn(read(index)) : say("Feito.")),
		});
		expect(error).toBeUndefined();
		expect(requests.every((request) => request.offered.some((name) => READ_TOOLS.includes(name)))).toBe(true);
		expect(requests.flatMap((request) => request.notes)).not.toContain(DELIVERABLE_RESERVE_NOTE);
	});

	it("em 100% do custo o run para com BudgetExhaustedError e o resumo honesto", async () => {
		const { result, error, requests } = await run({
			message: "pesquise o assunto",
			budget: { maxCostUsd: 0.5 },
			costOf: () => 0.25,
			driver: ({ index, toolChoice }) => (toolChoice === "none" ? say("Resumo parcial.") : turn(read(index))),
		});
		expect(result).toBeUndefined();
		expect(error).toBeInstanceOf(BudgetExhaustedError);
		expect((error as BudgetExhaustedError).message).toBe("custo máximo da execução atingido (US$ 0,50)");
		expect((error as BudgetExhaustedError).finalText).toBe("Resumo parcial.");
		// O pedido de resumo foi sem tools e o run parou na 2ª chamada de decisão.
		expect(requests.filter((request) => request.toolChoice === "auto")).toHaveLength(2);
	});

	it("sem teto (null/ausente) o custo nunca para o run", async () => {
		const { result, error } = await run({
			message: "pesquise o assunto",
			costOf: () => 5,
			driver: ({ index }) => (index < 5 ? turn(read(index)) : say("Feito.")),
		});
		expect(error).toBeUndefined();
		expect(result?.text).toBe("Feito.");
	});
});

describe("A3: guarda de releitura de artifact_read", () => {
	const big = Array.from({ length: 3_000 }, (_, i) => `row-${i} payload-${i}`).join(" ");

	it("com o artefato todo lido, reler vira aviso curto sem conteúdo e conta como zero novidade", async () => {
		artifactRows.clear();
		const total = { value: 0 };
		const { result, error, events, requests } = await run({
			message: "leia tudo e resuma",
			economy: true,
			mcpText: () => big,
			driver: ({ index, messages }) => {
				if (index === 0) return turn(call("d1", "mcp__data__dump_a"));
				if (total.value === 0) {
					const stub = messages.filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n");
					total.value = Number(/(\d+) characters/.exec(stub)?.[1] ?? 0);
				}
				const pages = Math.ceil(total.value / 8000);
				// Lê todas as páginas, depois relê três delas.
				const offset = index <= pages ? (index - 1) * 8000 : ((index - pages - 1) % 3) * 8000;
				return index <= pages + 3 ? turn(call(`a${index}`, "artifact_read", { id: "art-1", offset })) : say("Resumo final.");
			},
		});
		expect(error).toBeUndefined();
		expect(total.value).toBeGreaterThan(20_000);
		const reads = toolResults(events).filter((event) => event.name === "artifact_read");
		const rereads = reads.slice(-3);
		for (const reread of rereads) {
			expect(reread).toMatchObject({ ok: true });
			expect(String(reread.summary)).toMatch(/^Already read at step \d+; use what you have\.$/);
			expect(String(reread.summary)).not.toContain("row-");
		}
		// As três releituras não trouxeram nada: o aviso de estagnação sai depois delas.
		expect(requests.at(-1)!.notes).toContain(STAGNATION_NUDGE_CHANGE_APPROACH);
		expect(result?.text).toBe("Resumo final.");
	});
});

describe("A3: checkpoint do Jev (stuck)", () => {
	const jevWith = (ask: JevAsk): JevRuntime => ({ modes: { stuck: "on" }, ask });
	const answers = (stuck: number): JevAsk =>
		vi.fn(async ({ questions }) => ({
			model: "typesafe/jev-1.13",
			answers: Object.fromEntries(Object.keys(questions).map((key) => [key, key === "stuck" ? stuck : 0])),
			durationMs: 1,
		}));
	const askedSteps = (ask: JevAsk) => vi.mocked(ask).mock.calls.map((args) => (args[0].state as { step: number }).step);

	it("sem novidade por 2 decisões e nenhum aviso ainda: uma chamada, uma vez por sequência", async () => {
		const ask = answers(0.2);
		const { error } = await run({
			message: "pesquise o assunto",
			jev: jevWith(ask),
			mcpText: () => "a mesma página de sempre",
			driver: ({ index, toolChoice }) => (toolChoice === "none" ? say("Resumo.") : turn(read(index))),
		});
		expect(error).toBeUndefined();
		// Decisão 0 traz a página (novidade); 1 e 2 repetem: no passo 3 a sequência chega a 2.
		expect(askedSteps(ask).filter((step) => step < 8)).toEqual([3]);
	});

	it("'preso' fecha o run: sem tools, resposta com o que tem (sem abortar)", async () => {
		const ask = answers(0.95);
		const { result, error, requests } = await run({
			message: "pesquise o assunto",
			jev: jevWith(ask),
			mcpText: () => "a mesma página de sempre",
			driver: ({ index, toolChoice }) => (toolChoice === "none" ? say("Resumo do que deu.") : turn(read(index))),
		});
		expect(error).toBeUndefined();
		expect(result?.text).toBe("Resumo do que deu.");
		const closing = requests.find((request) => request.toolChoice === "none")!;
		expect(closing.index).toBe(3);
		expect(closing.notes).toContain(STUCK_ANSWER_NOW_NOTE);
	});

	it("falha ou indisponibilidade do Jev é ignorada: o run segue pela novidade", async () => {
		const ask: JevAsk = vi.fn(async () => {
			throw new Error("down");
		});
		const { result, error } = await run({
			message: "pesquise o assunto",
			jev: jevWith(ask),
			mcpText: () => "a mesma página de sempre",
			driver: ({ index, toolChoice }) => (toolChoice === "none" ? say("Resumo sem o Jev.") : turn(read(index))),
		});
		expect(error).toBeUndefined();
		expect(result?.text).toBe("Resumo sem o Jev.");
		expect(vi.mocked(ask).mock.calls.length).toBeGreaterThan(0);
	});

	it("run produtivo: no máximo uma chamada por passo, inclusive no checkpoint dos 100", async () => {
		const ask = answers(0);
		const { result, error } = await run({
			message: "pesquise a fundo o assunto",
			jev: jevWith(ask),
			driver: ({ index }) => (index < 105 ? turn(read(index)) : say("Done.")),
		});
		expect(error).toBeUndefined();
		expect(result?.text).toBe("Done.");
		const steps = askedSteps(ask);
		expect(steps.filter((step) => step === 100)).toHaveLength(1);
		expect(new Set(steps).size).toBe(steps.length);
		// Nunca a cada passo: cadência de 6 + checkpoints de 50.
		expect(steps.length).toBeLessThan(30);
	});
});

describe("A3: replay do caso real (pesquisa + muitas leituras + pedido de pdf)", () => {
	const big = Array.from({ length: 3_000 }, (_, i) => `row-${i} payload-${i}`).join(" ");

	it("o modelo fica relendo páginas do mesmo artefato e o PDF sai antes do teto", async () => {
		artifactRows.clear();
		const { result, error, requests, events } = await run({
			message: "pesquisa dnv e faz um pdf, quero algo mt completo",
			jev: WANTS_FILE_JEV,
			economy: true,
			maxSteps: 40,
			mcpText: () => big,
			driver: ({ index, offered, events: seen }) => {
				if (fileEvents(seen).length > 0) return say("Pronto: o PDF foi gerado com o que consegui levantar.");
				if (onlyFileTools(offered) && offered.includes("create_file")) return turn(fileCall(`f${index}`));
				if (index === 0) return turn(call("d1", "mcp__data__dump_a"));
				// Ciclo A, B, C de páginas do mesmo artefato (o que escapava da detecção de repetição).
				return turn(call(`a${index}`, "artifact_read", { id: "art-1", offset: ((index - 1) % 3) * 8000 }));
			},
		});
		expect(error).toBeUndefined();
		expect(fileEvents(events)).toHaveLength(1);
		expect(result?.text).toContain("PDF foi gerado");
		// Fechou bem antes do teto de 40 passos.
		const lastDecision = requests.at(-1)!.index;
		expect(lastDecision).toBeLessThan(30);
		expect(requests.some((request) => request.notes.includes(DELIVERABLE_STAGNATION_NOTE))).toBe(true);
	});
});


