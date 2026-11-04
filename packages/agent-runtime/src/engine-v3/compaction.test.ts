import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmMessage, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { AgentRunCheckpoint, ComputerUseEvent, EffectiveAutonomy } from "@workspace/shared";
import { buildMcpToolset } from "../mcp/registry.js";
import type { McpRuntime } from "../mcp/runtime.js";
import type { ComputerUseParams, RuntimeStepRecord } from "../run-types.js";
import { estimateMessagesTokens } from "../hygiene.js";
import { runEngineV3 } from "./loop.js";
import { COMPACTION_REPEAT_NOTE } from "./repetition.js";
import { COMPACTION_FLUSH_SUB_INDEX, COMPACTION_SUMMARY_SUB_INDEX, MEMORY_NOTES_MARKER, isSummaryMessage, rebuildConversation, taskListLines, withMemoryNotes } from "./compaction.js";

const memoryRuns: Array<Record<string, unknown>> = [];

vi.mock("../tools/registry/execute.js", async (original) => {
	const real = await original<typeof import("../tools/registry/execute.js")>();
	return {
		...real,
		executeTool: vi.fn(async (name: string, args: Record<string, unknown>, ctx: Parameters<typeof real.executeTool>[2]) => {
			if (name === "memory") {
				memoryRuns.push(args);
				return { summary: "Memória salva (add em memory)." };
			}
			return real.executeTool(name, args, ctx);
		}),
	};
});

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	searchMemoryEntries: vi.fn(async () => []),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	upsertTaskListCard: vi.fn(async () => undefined),
	getConversationUntrustedAt: vi.fn(async () => null),
	markConversationUntrusted: vi.fn(async () => undefined),
	markMcpTaskGrantsUntrusted: vi.fn(async () => undefined),
	findExecutedConfirmCall: vi.fn(async () => null),
	persistJevStatusCard: vi.fn(async () => undefined),
	loadAutonomyContext: vi.fn(async () => ({ accountRaw: null, botRaw: null, botName: "Cookie" })),
	saveSkillPendingIntent: vi.fn(async () => undefined),
}));

const erp = {
	id: "conn-erp",
	slug: "erp",
	name: "ERP",
	disabledTools: [],
	tools: [{ name: "buscar_cliente", description: "Busca cliente", inputSchema: { type: "object", properties: { nome: { type: "string" } } }, annotations: { readOnlyHint: true } }],
};
const READ = "mcp__erp__buscar_cliente";
const balanced = { level: "balanced", exceptions: [] } as unknown as EffectiveAutonomy;
const call = (id: string, args: Record<string, unknown>): LlmToolCall => ({ id, type: "function", function: { name: READ, arguments: JSON.stringify(args) } });
const tools = (...calls: LlmToolCall[]): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: null, tool_calls: calls }, finishReason: "tool_calls" });
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content }, finishReason: "stop" });
const read = (index: number) => tools(call(`r${index}`, { nome: `cliente ${index}` }));
const usage = { promptTokens: 900, completionTokens: 300, totalTokens: 1200, costUsd: 0.002 };

const SUMMARY_TEXT = "Objective: review 12 customers of the ERP one by one. Done: customers 0 to 9 were read and none needed changes (confirmed by tool result). Open items: report the result to the user.";
/** O array de tools do núcleo pesa ~7,7k tokens no cálculo (orçamentos reais são de dezenas de mil). */
const BUDGET = { targetTokens: 10_000, ceilingTokens: 16_000, keepSteps: [6, 4, 2], summarize: true } as const;
/** ~1,9k tokens cada: com 7 leituras a poda (6 grupos inteiros) sozinha passa de 16 mil e o resumo entra. */
const BIG = "x".repeat(6_000);

type Kind = "main" | "summary" | "flush";
type Seen = { kind: Kind; params: CompleteChatWithToolsParams };

async function runCompaction(input: {
	main: Array<CompleteChatWithToolsResult | ((seen: Seen[]) => CompleteChatWithToolsResult)>;
	summary?: () => CompleteChatWithToolsResult;
	flush?: () => CompleteChatWithToolsResult;
	budget?: Record<string, unknown>;
	ownTaskList?: boolean;
}) {
	const events: ComputerUseEvent[] = [];
	const steps: RuntimeStepRecord[] = [];
	const checkpoints: AgentRunCheckpoint[] = [];
	const seen: Seen[] = [];
	const queue = [...input.main];
	const mcpCall = vi.fn(async (_name: string, args: Record<string, unknown>) => ({ truncated: false, ok: true, text: `${String(args.nome)} ${BIG}` }));
	const mcp = { toolset: buildMcpToolset([erp], { autonomy: balanced }), call: mcpCall } as unknown as McpRuntime;
	const params: ComputerUseParams = {
		manager: {} as SandboxManager,
		getSessionId: async () => "session-1",
		sandboxEnabled: false,
		model: "m",
		apiKey: "test",
		runId: "run-v3",
		userId: "user-a",
		botId: "bot-cookie",
		conversationId: "conv-1",
		origin: "chat",
		humanTurn: true,
		messages: [{ role: "user", content: "Revise os clientes do ERP" }],
		timeZone: "America/Sao_Paulo",
		mcp,
		autonomy: balanced,
		contextBudget: (input.budget ?? BUDGET) as never,
		contextLength: 200_000,
		onEvent: (event) => {
			events.push(event);
		},
		onStep: async (step) => {
			steps.push(step);
		},
		onCheckpoint: async (checkpoint) => {
			checkpoints.push(JSON.parse(JSON.stringify(checkpoint)) as AgentRunCheckpoint);
		},
		streamChat: async (request) => {
			const system = typeof request.messages[0]?.content === "string" ? request.messages[0].content : "";
			const kind: Kind = request.tools.length === 0 && system.startsWith("You write the working memory") ? "summary" : system.startsWith("The older part of this conversation") ? "flush" : "main";
			seen.push({ kind, params: request });
			if (kind === "summary") return input.summary?.() ?? { model: "m", message: { role: "assistant", content: SUMMARY_TEXT }, finishReason: "stop", usage };
			if (kind === "flush") return input.flush?.() ?? { model: "m", message: { role: "assistant", content: "none" }, finishReason: "stop", usage };
			const next = queue.shift();
			if (!next) throw new Error("roteiro do modelo acabou");
			return typeof next === "function" ? next(seen) : next;
		},
	};
	const result = await runEngineV3(params, {}, { sleep: async () => undefined });
	const mains = seen.filter((item) => item.kind === "main");
	const results = events.filter((event): event is Extract<ComputerUseEvent, { type: "tool_result" }> => event.type === "tool_result");
	return { result, events, steps, checkpoints, seen, mains, results, mcpCall };
}

const script = (reads: number, tail: Array<CompleteChatWithToolsResult | ((seen: Seen[]) => CompleteChatWithToolsResult)> = [say("Revisei os clientes.")]) => [...Array.from({ length: reads }, (_, index) => read(index)), ...tail];
/** As notas de freio vão anexadas ao resultado que o MODELO recebe (não ao evento da UI). */
const toolTexts = (seen: Seen[]) => seen.filter((item) => item.kind === "main").at(-1)!.params.messages.filter((message) => message.role === "tool").map((message) => String(message.content));
const tokens = (params: CompleteChatWithToolsParams) => estimateMessagesTokens(params.messages, 0);
/** Pares chamada/resultado íntegros: toda chamada tem o seu resultado logo depois e todo resultado tem a sua chamada antes. */
function pairsIntact(messages: readonly LlmMessage[]): boolean {
	const called = new Set<string>();
	const answered = new Set<string>();
	for (const message of messages) {
		for (const item of message.tool_calls ?? []) called.add(item.id);
		if (message.role === "tool" && message.tool_call_id) answered.add(message.tool_call_id);
	}
	return [...called].every((id) => answered.has(id)) && [...answered].every((id) => called.has(id));
}

beforeEach(() => {
	vi.clearAllMocks();
	memoryRuns.length = 0;
});

describe("compactação v3: passo 1 (poda, sem LLM)", () => {
	it("cabendo no teto depois da poda, nenhuma chamada extra e nenhum marcador", async () => {
		const { seen, events, mains } = await runCompaction({ main: script(10), budget: { ...BUDGET, ceilingTokens: 24_000, targetTokens: 12_000 } });
		expect(seen.every((item) => item.kind === "main")).toBe(true);
		expect(events.some((event) => event.type === "context_compacted")).toBe(false);
		// O envio encolheu: resultados antigos viraram stub, mas as 6 leituras recentes seguem inteiras.
		const last = mains.at(-1)!.params;
		const joined = last.messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
		expect(joined).toContain("cliente 9");
		expect(joined).toMatch(/higiene|colapsad/i);
	});

	it("o histórico canônico não muda: o checkpoint guarda todos os resultados inteiros", async () => {
		const { checkpoints, mains } = await runCompaction({ main: script(10), budget: { ...BUDGET, ceilingTokens: 24_000, targetTokens: 12_000 } });
		const stored = (checkpoints.at(-1)!.llmMessages ?? []).filter((message) => message.role === "tool");
		expect(stored).toHaveLength(10);
		expect(stored.every((message) => typeof message.content === "string" && message.content.includes(BIG))).toBe(true);
		// ...enquanto a cópia enviada ao modelo já saiu podada.
		const sent = mains.at(-1)!.params.messages.filter((message) => message.role === "tool");
		expect(sent.some((message) => !String(message.content).includes(BIG))).toBe(true);
	});
});

describe("compactação v3: passo 2 (resumo)", () => {
	it("dispara só quando a poda não basta: flush, depois resumo, depois o passo normal", async () => {
		const { seen, events, mains, steps } = await runCompaction({
			main: script(12),
			flush: () => ({
				model: "m",
				message: { role: "assistant", content: null, tool_calls: [{ id: "f1", type: "function", function: { name: "memory", arguments: JSON.stringify({ action: "add", target: "user", content: "O usuario revisa clientes do ERP toda semana", user_asked: true }) } }] },
				finishReason: "tool_calls",
				usage,
			}),
		});
		const order = seen.map((item) => item.kind);
		const firstSummary = order.indexOf("summary");
		expect(firstSummary).toBeGreaterThan(0);
		expect(order[firstSummary - 1]).toBe("flush");
		expect(order.slice(0, firstSummary - 1).every((kind) => kind === "main")).toBe(true);
		// Memory flush: só `add`, e o modelo não decide `user_asked` (o porteiro avalia).
		expect(memoryRuns).toHaveLength(1);
		expect(memoryRuns[0]).toMatchObject({ action: "add", user_asked: false });

		// Marcador de UI: o evento que já existe, com antes > depois.
		const compacted = events.filter((event): event is Extract<ComputerUseEvent, { type: "context_compacted" }> => event.type === "context_compacted");
		expect(compacted).toHaveLength(1);
		expect(compacted[0]!.after).toBeLessThan(compacted[0]!.before * 0.8);

		// Prompt reconstruído: um system só, contexto com o fato salvo, resumo e pares íntegros.
		const after = mains.find((item, index) => index > 0 && item.params.messages.some((message) => isSummaryMessage(message)))!.params.messages;
		expect(after.filter((message) => message.role === "system")).toHaveLength(1);
		expect(after[0]!.role).toBe("system");
		const context = after[1]!;
		expect(typeof context.content === "string" && context.content.startsWith("[context]")).toBe(true);
		expect(String(context.content)).toContain(MEMORY_NOTES_MARKER);
		expect(String(context.content)).toContain("O usuario revisa clientes do ERP toda semana");
		expect(isSummaryMessage(after[2]!)).toBe(true);
		expect(String(after[2]!.content)).toContain("review 12 customers");
		expect(pairsIntact(after)).toBe(true);
		expect(after.filter((message) => message.role === "system" && message !== after[0])).toHaveLength(0);

		// Custo: span do resumo e do flush, com o mesmo nome que o worker já ignora nos sinais.
		const summarySpan = steps.find((step) => step.subIndex === COMPACTION_SUMMARY_SUB_INDEX)!;
		expect(summarySpan).toMatchObject({ type: "tool", status: "completed", inputJson: { name: "context_summary" }, tokens: 1200 });
		expect(steps.find((step) => step.subIndex === COMPACTION_FLUSH_SUB_INDEX)).toMatchObject({ outputJson: { phase: "memory_flush", saved: 1 } });
		// O pedido do resumo tem teto de saída e vai sem tools.
		const request = seen[firstSummary]!.params;
		expect(request.tools).toEqual([]);
		expect(request.maxOutputTokens).toBeLessThanOrEqual(2_500);
	});

	it("flush sem fato durável (o modelo responde none) não grava nada e o resumo segue", async () => {
		const { seen } = await runCompaction({ main: script(12) });
		expect(seen.some((item) => item.kind === "summary")).toBe(true);
		expect(memoryRuns).toHaveLength(0);
	});

	it("resumo vazio mantém o original; 3 falhas terminam com resposta honesta (FINAL_STEP), sem abortar", async () => {
		const { result, seen, events } = await runCompaction({
			main: [...script(24, []), say("Parei: a conversa ficou longa demais para continuar."), say("fim")],
			summary: () => ({ model: "m", message: { role: "assistant", content: "" }, finishReason: "stop", usage }),
		});
		expect(seen.filter((item) => item.kind === "summary")).toHaveLength(3);
		expect(events.some((event) => event.type === "context_compacted")).toBe(false);
		expect(result.stop).toMatchObject({ reason: "budget_context" });
		expect(result.text).toContain("Parei");
		// O FINAL_STEP mantém as tools no pedido e proíbe nova chamada.
		const final = seen.filter((item) => item.kind === "main").at(-1)!.params;
		expect(final.toolChoice).toBe("none");
	});

	it("economia (sem resumo no orçamento): só a poda da cópia, nenhuma chamada extra", async () => {
		const { seen } = await runCompaction({ main: script(12), budget: { targetTokens: 3_000, ceilingTokens: 6_000 } });
		expect(seen.every((item) => item.kind === "main")).toBe(true);
	});
});

/** Lê clientes distintos até o resumo acontecer; então `after` decide o que o modelo faz (repetir a última leitura ou seguir). */
function adaptive(after: "repeat" | "new") {
	let next = 0;
	let compactedAt = -1;
	const step = (seen: Seen[]): CompleteChatWithToolsResult => {
		if (compactedAt < 0 && seen.some((item) => item.kind === "summary")) compactedAt = next;
		if (compactedAt < 0) return read(next++);
		if (after === "repeat") return read(compactedAt - 1);
		return next - compactedAt < 1 ? read(next++) : say("Concluído.");
	};
	return Array.from({ length: 20 }, () => step);
}

describe("compactação v3: guarda pós-compactação", () => {
	it("repetir a última chamada de antes (mesmo resultado) recebe a nota e, na 2ª vez, o FINAL_STEP", async () => {
		const { seen, result } = await runCompaction({ main: [...adaptive("repeat"), say("Parei por repetição.")] });
		expect(toolTexts(seen).filter((text) => text.includes(COMPACTION_REPEAT_NOTE))).toHaveLength(2);
		expect(result.stop?.reason).toBe("loop_repeat");
	});

	it("não dispara à toa: depois de compactar, uma chamada nova segue sem nota nenhuma", async () => {
		const { seen, result } = await runCompaction({ main: adaptive("new") });
		expect(result.text).toBe("Concluído.");
		expect(result.stop).toEqual({ reason: "answered" });
		expect(toolTexts(seen).some((text) => text.includes(COMPACTION_REPEAT_NOTE))).toBe(false);
	});
});

describe("T12: conversa longa que força a compactação não repete trabalho", () => {
	it("cada cliente é lido uma vez, o resumo carrega o que foi feito e o run entrega a resposta", async () => {
		const { seen, mcpCall, result, events } = await runCompaction({
			main: script(12, [say("Revisei os 12 clientes; nenhum precisou de ajuste.")]),
		});
		const compacted = events.filter((event) => event.type === "context_compacted");
		expect(compacted).toHaveLength(1);
		const nomes = mcpCall.mock.calls.map((item) => String(item[1].nome));
		expect(new Set(nomes).size).toBe(nomes.length);
		expect(nomes).toHaveLength(12);
		// O resumo recebeu a transcrição das leituras antigas (o que já foi feito) e o objetivo.
		const summaryRequest = seen.find((item) => item.kind === "summary")!.params;
		const user = String(summaryRequest.messages[1]!.content);
		expect(user).toContain("cliente 0");
		expect(result.text).toBe("Revisei os 12 clientes; nenhum precisou de ajuste.");
		expect(result.stop).toEqual({ reason: "answered" });
	});
});

describe("compactação v3: funções puras", () => {
	it("withMemoryNotes acrescenta os fatos sem duplicar os de compactações anteriores e respeita o teto", () => {
		const first = withMemoryNotes("[context] base", ["fato A"]);
		expect(first).toBe(`[context] base\n\n${MEMORY_NOTES_MARKER}\n- fato A`);
		const second = withMemoryNotes(first, ["fato A", "fato B"]);
		expect(second).toBe(`[context] base\n\n${MEMORY_NOTES_MARKER}\n- fato A\n- fato B`);
		expect(withMemoryNotes("[context] base", [])).toBe("[context] base");
		const many = withMemoryNotes("[context] base", Array.from({ length: 40 }, (_, index) => `fato ${index}`));
		expect(many.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(20);
		expect(many).toContain("fato 39");
		expect(many).not.toContain("fato 0\n");
	});

	it("rebuildConversation: system, contexto, resumo e recentes, sem mexer nos pares", () => {
		const recent: LlmMessage[] = [
			{ role: "assistant", content: null, tool_calls: [call("a", { nome: "x" })] },
			{ role: "tool", tool_call_id: "a", content: "ok" },
			{ role: "user", content: "e agora?" },
		];
		const next = rebuildConversation({
			system: [{ role: "system", content: "sys" }],
			context: { role: "user", content: "[context] c" },
			contextFacts: [],
			note: "[Conversation summary] resumo",
			recent,
		});
		expect(next.map((message) => message.role)).toEqual(["system", "user", "user", "assistant", "tool", "user"]);
		expect(next[1]!.content).toBe("[context] c");
		expect(isSummaryMessage(next[2]!)).toBe(true);
		expect(pairsIntact(next)).toBe(true);
	});

	it("taskListLines lista o estado da lista do modelo", () => {
		expect(taskListLines([{ id: "1", content: "Ler clientes", status: "in_progress" }] as never)).toEqual(["- [in_progress] Ler clientes"]);
		expect(taskListLines(undefined)).toEqual([]);
	});
});
