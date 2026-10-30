import { describe, expect, it, vi } from "vitest";
import { anthropicRequestBody, chatRequestBody, responsesRequestBody, type CompleteChatWithToolsParams } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { TRANSCRIPT_SLOT, type SerializedLlmMessage } from "@workspace/shared";
import { runComputerUse } from "./computer-use.js";
import { buildTranscriptHistory, cleanTranscript, namespaceToolCallIds } from "./context/transcript.js";
import { buildMcpToolset } from "./mcp/registry.js";
import type { McpRuntime } from "./mcp/runtime.js";
import { ERP_CONNECTION, EXPOSED, assistantCalls, assistantSays, fakeErp, toolCall } from "./harness-regression.fixtures.js";

/**
 * Prefixo de cache estável entre turnos: o pedido do primeiro passo do turno 2 começa, mensagem a mensagem e byte
 * a byte, com o último pedido do turno 1 (sem as marcas de breakpoint, que só dizem ONDE cortar). Notas de turno,
 * ids de chamada e resultados de ferramenta participam; o que muda de turno para turno vai depois do prefixo.
 */

vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	upsertTaskListCard: vi.fn(async () => undefined),
}));

type Message = CompleteChatWithToolsParams["messages"][number];

async function runTurn(input: {
	runId: string;
	user: string;
	/** Catálogo adiado: as tools do conector só entram depois de `mcp_tool_search` (ou carregadas do turno anterior). */
	deferred?: boolean;
	/** Notas de turno como o worker as monta: mensagens de sistema DEPOIS da fala do usuário. */
	notes: string[];
	script: Array<ReturnType<typeof assistantSays>>;
	priorTranscript?: SerializedLlmMessage[];
	priorLoadedTools?: string[];
}) {
	const erp = fakeErp();
	const mcp: McpRuntime = { toolset: buildMcpToolset([ERP_CONNECTION], { autonomy: { level: "balanced", exceptions: [] }, ...(input.deferred ? { maxTools: 2 } : {}) }), call: erp.call };
	const requests: CompleteChatWithToolsParams[] = [];
	const checkpoints: Array<{ llmMessages?: SerializedLlmMessage[]; loadedTools?: string[] }> = [];
	const queue = [...input.script];
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		sandboxEnabled: false,
		apiKey: "test",
		model: "anthropic/claude-sonnet-5.5",
		runId: input.runId,
		userId: "user-a",
		botId: "bot-a",
		conversationId: "conv-prefix",
		origin: "chat",
		maxSteps: 8,
		mcp,
		autonomy: { level: "balanced", exceptions: [] },
		priorTranscript: input.priorTranscript,
		priorLoadedTools: input.priorLoadedTools,
		messages: [
			{ role: "system", content: "identidade do bot" },
			...(input.priorTranscript ? [{ role: "system" as const, content: TRANSCRIPT_SLOT }] : []),
			{ role: "user", content: input.user },
			...input.notes.map((content) => ({ role: "system" as const, content })),
		],
		onEvent: () => undefined,
		onCheckpoint: async (checkpoint) => { checkpoints.push(JSON.parse(JSON.stringify(checkpoint))); },
		streamChat: async (params) => {
			requests.push(JSON.parse(JSON.stringify(params)));
			const next = queue.shift();
			if (!next) throw new Error("LLM extra: o roteiro acabou");
			return next;
		},
	});
	return { requests, last: checkpoints.at(-1) as ({ llmMessages?: SerializedLlmMessage[]; loadedTools?: string[] }) | undefined };
}

/** O que o worker faz entre os turnos: limpa, prefixa (no-op para ids que já nasceram prefixados) e junta o que o banco ganhou. */
function carry(prev: { runId: string; llmMessages?: SerializedLlmMessage[] }, after: Array<{ role: string; content: string }>, objective: string) {
	const cleaned = cleanTranscript(prev.llmMessages, { model: "anthropic/claude-sonnet-5.5" })!;
	expect(cleaned).not.toBeNull();
	return buildTranscriptHistory({ transcript: namespaceToolCallIds(cleaned, prev.runId), after, objective });
}

/** Sem marca de breakpoint e com texto puro como string: a marca só diz onde cortar, não é conteúdo. */
function plain(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value, (key, item) => (key === "cache_control" ? undefined : item)), (_key, item) => {
		if (Array.isArray(item) && item.length > 0 && item.every((part) => part && typeof part === "object" && part.type === "text" && Object.keys(part).length === 2)) {
			return item.map((part: { text: string }) => part.text).join("\n");
		}
		return item;
	});
}

const NOTE_ARTIFACTS = "Earlier results in this conversation (read with artifact_read): proposal.pdf (art-1).";
const NOTE_TASK = "Active task context: the user is building a sales order for customer Exemplo.";

async function twoTurns() {
	const one = await runTurn({
		runId: "run-aaa111",
		user: "Ache o cliente Exemplo",
		notes: [NOTE_ARTIFACTS, NOTE_TASK],
		script: [assistantCalls(toolCall("call_0", EXPOSED.findCustomer, { name: "Exemplo" })), assistantSays("Achei o cliente Exemplo. Qual o pagamento?")],
	});
	const priorTranscript = carry(
		{ runId: "run-aaa111", llmMessages: one.last?.llmMessages },
		[{ role: "assistant", content: "Achei o cliente Exemplo. Qual o pagamento?" }, { role: "user", content: "Boleto 30 dias" }],
		"Boleto 30 dias",
	);
	const two = await runTurn({
		runId: "run-bbb222",
		user: "Boleto 30 dias",
		notes: ["Active task context: payment chosen next.", "Relevant memory: the customer prefers boleto."],
		script: [assistantCalls(toolCall("call_0", EXPOSED.listPaymentMethods)), assistantSays("Formas listadas.")],
		priorTranscript,
	});
	return { one, two };
}

describe("prefixo de cache estável entre turnos", () => {
	it("ids de chamada nascem prefixados com o run e o que foi enviado é o que fica gravado", async () => {
		const { one, two } = await twoTurns();
		const sentCalls = one.requests.at(-1)!.messages.flatMap((m: Message) => m.tool_calls ?? []);
		expect(sentCalls.map((c) => c.id)).toEqual(["raaa111_call_0"]);
		const stored = one.last!.llmMessages!;
		expect(stored.flatMap((m) => m.tool_calls ?? []).map((c) => c.id)).toEqual(["raaa111_call_0"]);
		expect(stored.filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(["raaa111_call_0"]);
		// o turno 2 reenvia o mesmo id e o id novo, igual a "call_0" do provedor, não colide
		const ids = two.requests.at(-1)!.messages.flatMap((m: Message) => m.tool_calls ?? []).map((c) => c.id);
		expect(ids).toEqual(["raaa111_call_0", "rbbb222_call_0"]);
	});

	it("as notas do turno vão depois da fala do usuário e ficam gravadas na posição em que foram enviadas", async () => {
		const { one } = await twoTurns();
		const first = one.requests[0]!.messages;
		const userAt = first.findIndex((m: Message) => m.role === "user");
		expect(first.slice(userAt + 1, userAt + 3).map((m: Message) => m.content)).toEqual([NOTE_ARTIFACTS, NOTE_TASK]);
		const stored = one.last!.llmMessages!;
		const storedUser = stored.findIndex((m) => m.role === "user");
		expect(stored.slice(storedUser + 1, storedUser + 3).map((m) => m.content)).toEqual([NOTE_ARTIFACTS, NOTE_TASK]);
	});

	it("corpo OpenRouter (Claude): o pedido do passo 1 do turno 2 começa com todas as mensagens do último pedido do turno 1", async () => {
		const { one, two } = await twoTurns();
		const body = (params: CompleteChatWithToolsParams) => chatRequestBody(params, true);
		const prev = body(one.requests.at(-1)!).messages as Message[];
		const next = body(two.requests[0]!).messages as Message[];
		const a = plain(prev) as Message[];
		const b = plain(next) as Message[];
		// As notas do turno vão coladas na fala do usuário (um turno só), por isso o pedido tem menos mensagens.
		expect(prev.length).toBeGreaterThan(3);
		expect(b.slice(0, a.length)).toEqual(a);
		expect(JSON.stringify(b).startsWith(JSON.stringify(a).slice(0, -1))).toBe(true);
		// o que é novo no turno 2 vem depois do prefixo: resposta do turno 1, fala nova e notas novas
		const tail = b.slice(a.length).map((m) => JSON.stringify(m.content)).join("\n");
		expect(tail).toContain("Achei o cliente Exemplo");
		expect(tail).toContain("Boleto 30 dias");
		expect(tail).toContain("customer prefers boleto");
	});

	it("corpo Anthropic: tools e system iguais, mensagens com o prefixo do turno 1 e breakpoints no sistema, no fim do pedido anterior e no último", async () => {
		const { one, two } = await twoTurns();
		const slug = "claude-sonnet-5.5";
		const prevBody = anthropicRequestBody(one.requests.at(-1)!, slug);
		const nextBody = anthropicRequestBody(two.requests[0]!, slug);
		expect(plain(nextBody.tools)).toEqual(plain(prevBody.tools));
		expect(plain(nextBody.system)).toEqual(plain(prevBody.system));
		const a = plain(prevBody.messages) as unknown[];
		const b = plain(nextBody.messages) as unknown[];
		expect(b.slice(0, a.length)).toEqual(a);
		expect(JSON.stringify(b).startsWith(JSON.stringify(a).slice(0, -1))).toBe(true);
		// breakpoints: tools/sistema, fim do pedido anterior (a mensagem logo antes da última fala do assistente) e a última mensagem
		// Fim do pedido anterior pode ser um resultado de tool (as notas do runtime vão anexadas a ele): o breakpoint vai no bloco tool_result.
		const hasMark = (blocks: Array<{ type: string; cache_control?: unknown }>) => blocks.some((block) => (block.type === "text" || block.type === "tool_result") && block.cache_control);
		const marked = nextBody.messages.flatMap((m, index) => (hasMark(m.content) ? [index] : []));
		const lastAssistant = nextBody.messages.map((m) => m.role).lastIndexOf("assistant");
		expect(Boolean(nextBody.system?.some((block) => block.cache_control)) || Boolean(nextBody.tools?.some((tool) => tool.cache_control))).toBe(true);
		expect(marked).toContain(nextBody.messages.length - 1);
		// o fim do pedido anterior é a mensagem logo antes da resposta final do turno 1
		expect(a.length).toBe(lastAssistant);
		expect(marked).toContain(a.length - 1);
	});

	it("corpo Responses (ChatGPT): instructions e entrada com o prefixo do turno 1", async () => {
		const { one, two } = await twoTurns();
		const body = (params: CompleteChatWithToolsParams) => responsesRequestBody({ ...params, model: "chatgpt/gpt-5" }, "gpt-5");
		const prev = body(one.requests.at(-1)!);
		const next = body(two.requests[0]!);
		expect(next.instructions).toBe(prev.instructions);
		expect(next.input.slice(0, prev.input.length)).toEqual(prev.input);
		expect(JSON.stringify(next.input).startsWith(JSON.stringify(prev.input).slice(0, -1))).toBe(true);
	});

	it("a lista de tools do pedido do turno 2 começa com a do último pedido do turno 1 (tool carregada no meio do turno 1 continua no mesmo lugar)", async () => {
		const one = await runTurn({
			runId: "run-aaa111",
			user: "Ache o cliente Exemplo",
			deferred: true,
			notes: [NOTE_ARTIFACTS],
			script: [
				assistantCalls(toolCall("call_0", "mcp_tool_search", { query: EXPOSED.findCustomer })),
				assistantCalls(toolCall("call_1", EXPOSED.findCustomer, { name: "Exemplo" })),
				assistantSays("Achei o cliente Exemplo."),
			],
		});
		const names = (params: CompleteChatWithToolsParams) => params.tools.map((tool) => tool.function.name);
		expect(names(one.requests[0]!)).not.toContain(EXPOSED.findCustomer);
		expect(names(one.requests.at(-1)!)).toContain(EXPOSED.findCustomer);
		const priorTranscript = carry({ runId: "run-aaa111", llmMessages: one.last?.llmMessages }, [{ role: "assistant", content: "Achei o cliente Exemplo." }, { role: "user", content: "e agora" }], "e agora");
		const two = await runTurn({ runId: "run-bbb222", user: "e agora", deferred: true, notes: [], script: [assistantSays("ok")], priorTranscript, priorLoadedTools: one.last?.loadedTools });
		const prevTools = names(one.requests.at(-1)!);
		expect(names(two.requests[0]!).slice(0, prevTools.length)).toEqual(prevTools);
		// e o corpo da Anthropic: mesmas tools, na mesma ordem, e o mesmo bloco de sistema
		const slug = "claude-sonnet-5.5";
		expect(plain(anthropicRequestBody(two.requests[0]!, slug).tools)).toEqual(plain(anthropicRequestBody(one.requests.at(-1)!, slug).tools));
	});

	it("o prompt de sistema do turno 2 é o do turno 1 (nada por turno nele)", async () => {
		const { one, two } = await twoTurns();
		const head = (params: CompleteChatWithToolsParams) => params.messages.slice(0, 2).map((m: Message) => m.content);
		expect(head(two.requests[0]!)).toEqual(head(one.requests[0]!));
	});
});
