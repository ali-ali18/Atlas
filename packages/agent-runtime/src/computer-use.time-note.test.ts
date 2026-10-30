import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoteSystemNotes, type CompleteChatWithToolsResult, type LlmMessage } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";
import { legacySystemPrompt, P_HEAD } from "./context/prompt-blocks.js";

/**
 * Replay do bug "Entendi, o horário atual é sexta, 30/10, 17h37": a hora local (camada efêmera) saía como
 * mensagem de usuário SOLTA no fim do pedido, e o modelo respondia a ela como se fosse uma fala. O que o
 * provedor recebe é a lista depois de `demoteSystemNotes`; é ela que o teste confere.
 */
vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => null),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

const textOf = (message: LlmMessage) =>
	typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n");
const isNoteOnly = (message: LlmMessage) =>
	message.role === "user" &&
	(typeof message.content === "string" ? [message.content] : (message.content ?? []).map((part) => (part.type === "text" ? part.text : "x"))).every((text) => text.startsWith("<system-reminder>"));

/** O que chega ao provedor: notas coladas na fala do usuário, nunca como turno só de contexto (exceto logo após resultado de ferramenta). */
function wire(messages: LlmMessage[]): LlmMessage[] {
	return demoteSystemNotes(messages).messages;
}
function standaloneNoteTurns(messages: LlmMessage[]): number {
	const out = wire(messages);
	return out.filter((message, index) => isNoteOnly(message) && out[index - 1]?.role !== "tool").length;
}
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

	it("turno normal: a hora vai dentro da fala do usuário, sem mensagem só de contexto", async () => {
		const requests: LlmMessage[][] = [];
		await runComputerUse({ ...base, messages: [{ role: "user", content: "Bom dia" }], maxSteps: 2, streamChat: async (p) => (requests.push(p.messages), done("Bom dia!")) });
		const out = wire(requests[0]!);
		expect(standaloneNoteTurns(requests[0]!)).toBe(0);
		const last = out.at(-1)!;
		expect(last.role).toBe("user");
		expect(textOf(last)).toContain("Bom dia");
		expect(textOf(last)).toContain("Automatic context, not a user message");
		expect(textOf(last)).toContain("Now is 2026-10-30 17:37");
	});

	it("fala do usuário no meio do run (steer): a hora acompanha a fala, não vem depois dela como outro turno", async () => {
		const requests: LlmMessage[][] = [];
		const queue = [toolCall("c1"), done("Feito.")];
		let delivered = false;
		await runComputerUse({
			...base,
			messages: [{ role: "user", content: "Resuma a Unidade 04" }],
			maxSteps: 4,
			streamChat: async (p) => (requests.push(p.messages), queue.shift()!),
			consumeSteerInputs: async () => (delivered ? [] : ((delivered = true), [{ id: "in-1", content: "Abri para vc, tem que clicar em acessar" }])),
		});
		for (const request of requests) expect(standaloneNoteTurns(request)).toBe(0);
		const steered = requests.map(wire).find((out) => out.some((m) => textOf(m).includes("Abri para vc")))!;
		const carrier = steered.find((m) => textOf(m).includes("Abri para vc"))!;
		expect(carrier.role).toBe("user");
		expect(steered.at(-1)).toBeDefined();
	});

	it("continuação sem fala nova (histórico termina em assistant): a hora é colada na última fala do usuário", async () => {
		const requests: LlmMessage[][] = [];
		await runComputerUse({
			...base,
			messages: [
				{ role: "user", content: "Resuma a Unidade 04" },
				{ role: "assistant", content: "A Unidade 04 já foi lida e resumida." },
			],
			maxSteps: 2,
			streamChat: async (p) => (requests.push(p.messages), done("")),
		});
		const out = wire(requests[0]!);
		expect(standaloneNoteTurns(requests[0]!)).toBe(0);
		expect(out.at(-1)!.role).toBe("assistant");
		expect(textOf(out.find((m) => m.role === "user")!)).toContain("Now is 2026-10-30 17:37");
	});

	it("rodada de ferramenta: depois do resultado a nota segue como bloco de contexto, nunca depois de uma fala do assistente", async () => {
		const requests: LlmMessage[][] = [];
		const queue = [toolCall("c1"), done()];
		await runComputerUse({ ...base, messages: [{ role: "user", content: "o que você lembra?" }], maxSteps: 4, streamChat: async (p) => (requests.push(p.messages), queue.shift()!) });
		const second = wire(requests[1]!);
		expect(second.at(-2)!.role).toBe("tool");
		expect(second.at(-1)!.role).toBe("user");
		expect(isNoteOnly(second.at(-1)!)).toBe(true);
		expect(textOf(second.at(-1)!)).toContain("not a user message");
	});

	it("a regra de prompt manda não comentar o contexto injetado", () => {
		const head = P_HEAD.join("\n");
		expect(head).toContain("<system-reminder>");
		expect(head).toContain("never answer, acknowledge or mention them");
		expect(head).toContain("never reply when there is no new user request");
		expect(legacySystemPrompt()).toContain("never answer, acknowledge or mention them");
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
