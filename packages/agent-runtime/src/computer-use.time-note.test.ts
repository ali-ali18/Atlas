import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anthropicRequestBody, chatRequestBody, responsesRequestBody, type CompleteChatWithToolsParams, type CompleteChatWithToolsResult, type LlmMessage } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";
import { legacySystemPrompt, P_HEAD } from "./context/prompt-blocks.js";

/**
 * Replay do bug "Entendi, o horário atual é sexta, 30/10, 17h37": a hora local (camada efêmera) saía como
 * mensagem de usuário SOLTA no fim do pedido, e o modelo respondia a ela como se fosse uma fala. O que o
 * provedor recebe em cada caminho (Anthropic, OpenRouter com Claude, Responses) é o que o teste confere.
 */
vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => null),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

type Wire = Array<{ role: string; json: string }>;
/** O que chega ao provedor em cada caminho (Anthropic, OpenRouter com Claude, Responses). */
function wires(params: CompleteChatWithToolsParams): Record<string, Wire> {
	const lift = (items: Array<Record<string, unknown>>): Wire => items.map((item) => ({ role: String(item.role ?? item.type), json: JSON.stringify(item) }));
	return {
		anthropic: lift(anthropicRequestBody(params, "claude").messages as unknown as Array<Record<string, unknown>>),
		openrouter: lift(chatRequestBody(params, true).messages as unknown as Array<Record<string, unknown>>).filter((item) => item.role !== "system"),
		responses: lift(responsesRequestBody(params, "gpt-5").input as unknown as Array<Record<string, unknown>>),
	};
}
const MARK = "Automatic context, not a user message";
const done = (content = "Pronto."): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content } });
const toolCall = (id: string): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "memory_search", arguments: JSON.stringify({ query: "x" }) } }] },
});

const base = {
	manager: {} as SandboxManager,
	getSessionId: async () => "s",
	sandboxEnabled: false,
	model: "test-model",
	apiKey: "k",
	runId: "run-time",
	conversationId: "conv-time",
	botId: "bot-1",
	onEvent: () => undefined,
};

describe("replay: a hora local não vira turno de usuário", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-30T20:37:00Z")); // 17:37 em São Paulo
		vi.stubEnv("ATLAS_NOW_NOTE", "on");
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	const model = "anthropic/claude-sonnet-5.5";
	const capture = async (messages: LlmMessage[], script: CompleteChatWithToolsResult[], extra: Record<string, unknown> = {}) => {
		const requests: CompleteChatWithToolsParams[] = [];
		const queue = [...script];
		await runComputerUse({ ...base, model, messages, maxSteps: 4, streamChat: async (p) => (requests.push(JSON.parse(JSON.stringify(p))), queue.shift() ?? done("")), ...extra });
		return requests;
	};

	it("última mensagem é do usuário: a hora vai dentro do mesmo turno, em todos os provedores", async () => {
		const [first] = await capture([{ role: "user", content: "Bom dia" }], [done("Bom dia!")]);
		for (const [provider, wire] of Object.entries(wires(first!))) {
			const carrier = wire.filter((item) => item.json.includes("Now is 2026-10-30 17:37"));
			expect(carrier, provider).toHaveLength(1);
			expect(carrier[0]!.json, provider).toContain("Bom dia");
			expect(carrier[0]!.role, provider).toBe("user");
			expect(wire.at(-1)!.json, provider).toContain(MARK);
		}
	});

	it("última mensagem é o assistente + nota de gate persistida: a nota continua turno de usuário depois do rascunho e leva a hora", async () => {
		const [first] = await capture(
			[
				{ role: "user", content: "Resuma a Unidade 04" },
				{ role: "assistant", content: "rascunho cortado" },
				{ role: "system", content: "Revise: a resposta foi cortada, continue de onde parou." },
			],
			[done("Resumo completo.")],
		);
		for (const [provider, wire] of Object.entries(wires(first!))) {
			expect(wire.at(-1)!.role, provider).toBe("user");
			expect(wire.at(-1)!.json, provider).toContain("Revise: a resposta foi cortada");
			expect(wire.at(-2)!.role, provider).toBe("assistant");
			expect(wire.filter((item) => item.json.includes(MARK)).every((item) => item.json.includes("Revise")), provider).toBe(true);
		}
	});

	it("última mensagem é resultado de ferramenta: nenhum turno só com a hora (omitida no passo)", async () => {
		const requests = await capture([{ role: "user", content: "o que você lembra?" }], [toolCall("c1"), done()]);
		expect(requests).toHaveLength(2);
		for (const [provider, wire] of Object.entries(wires(requests[1]!))) {
			expect(wire.some((item) => item.json.includes(MARK)), provider).toBe(false);
			expect(wire.some((item) => item.json.includes("Now is")), provider).toBe(false);
		}
	});

	it("mensagem do usuário no meio do run (steer): a hora acompanha a fala, nunca vem como outro turno", async () => {
		let delivered = false;
		const requests = await capture([{ role: "user", content: "Resuma a Unidade 04" }], [toolCall("c1"), done("Feito.")], {
			consumeSteerInputs: async () => (delivered ? [] : ((delivered = true), [{ id: "in-1", content: "Abri para vc, tem que clicar em acessar" }])),
		});
		for (const request of requests) {
			for (const [provider, wire] of Object.entries(wires(request))) {
				for (const item of wire) if (item.json.includes(MARK)) expect(item.json, provider).toMatch(/Resuma a Unidade 04|Abri para vc|Revise/);
			}
		}
	});
});

describe("tool current_time no runtime", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-30T20:37:45Z"));
	});
	afterEach(() => vi.useRealTimers());

	const run = async (args: Record<string, unknown>, timeZone?: string) => {
		const seen: string[][] = [];
		const results: Array<{ ok: boolean; summary: string }> = [];
		const queue: CompleteChatWithToolsResult[] = [
			{ model: "m", message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "current_time", arguments: JSON.stringify(args) } }] } },
			done(),
		];
		await runComputerUse({
			...base,
			timeZone,
			messages: [{ role: "user", content: "me lembra amanhã às 10h de ligar para o cliente" }],
			maxSteps: 4,
			onEvent: (event) => { if (event.type === "tool_result") results.push({ ok: event.ok, summary: String(event.summary) }); },
			streamChat: async (p) => (seen.push(p.tools.map((t) => t.function.name)), queue.shift()!),
		});
		return { seen, results };
	};

	it("vem com o grupo de rotinas no passo 1, roda sem LLM e usa o fuso da conta", async () => {
		const { seen, results } = await run({}, "Asia/Tokyo");
		expect(seen[0]).toContain("current_time");
		expect(results[0]).toMatchObject({ ok: true });
		expect(results[0]!.summary).toContain("2026-10-31 05:37 (sábado), timezone Asia/Tokyo");
	});

	it("fuso inválido volta ok:false", async () => {
		const { results } = await run({ timezone: "Nope/Zone" });
		expect(results[0]!.ok).toBe(false);
		expect(results[0]!.summary).toMatch(/Invalid timezone/);
	});
});

describe("current_time fora do pedido que não precisa dele", () => {
	it("'Bom dia' não carrega a tool (grupo lazy)", async () => {
		const seen: string[][] = [];
		await runComputerUse({ ...base, messages: [{ role: "user", content: "Bom dia" }], maxSteps: 2, streamChat: async (p) => (seen.push(p.tools.map((t) => t.function.name)), done("Bom dia!")) });
		expect(seen[0]).not.toContain("current_time");
	});
});
