import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTool, CompleteChatWithToolsResult, LlmMessage, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { FakeTable, installFakes } from "@workspace/db/testing";
import { persistConversationCardFromEvent } from "@workspace/db";
import { isBareBotCreateRequest, type ComputerUseEvent } from "@workspace/shared";
import { runComputerUse } from "./computer-use.js";

/**
 * `propose_bot`: o agente propõe criar outro agente. Só emite o card; nada é criado
 * antes do dono aprovar. Só em chat com o usuário, uma proposta por turno, e pedido
 * vago manda perguntar antes. Prisma em memória; LLM mockado, sem rede.
 */

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	searchMemoryEntries: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

const USER = "user-a";
let docs: FakeTable;
let bots: FakeTable;
let installed: { restore: () => void };

beforeEach(() => {
	vi.mocked(persistConversationCardFromEvent).mockClear();
	docs = new FakeTable([], () => ({ createdAt: new Date(), updatedAt: new Date(), revision: 1, enabled: true, status: "active", createdBy: "user", tools: [], botId: null }));
	bots = new FakeTable([{ id: "bot-a", ownerId: USER }]);
	installed = installFakes({ skillDoc: docs, skillRevision: new FakeTable(), bot: bots });
});
afterEach(() => installed.restore());

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

async function run(input: { message?: string; script?: CompleteChatWithToolsResult[]; origin?: string }) {
	const requests: Request[] = [];
	const results: Array<{ name: string; ok: boolean; summary: string }> = [];
	const events: ComputerUseEvent[] = [];
	let decision = 0;
	const script = input.script ?? [done];
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		sandboxEnabled: false,
		apiKey: "test",
		model: "m",
		runId: "run-bp",
		conversationId: "conv-bp",
		userId: USER,
		botId: "bot-a",
		origin: (input.origin ?? "chat") as "chat",
		contextEconomy: true,
		messages: [{ role: "user", content: input.message ?? "Cria um agente que acompanha meu estoque e avisa quando algo acaba" }],
		maxSteps: 6,
		onEvent: (event) => {
			events.push(event);
			if (event.type === "tool_result") results.push({ name: event.name, ok: event.ok, summary: event.summary });
		},
		streamChat: async (params) => {
			requests.push({
				tools: JSON.parse(JSON.stringify(params.tools)) as ChatTool[],
				messages: JSON.parse(JSON.stringify(params.messages)) as LlmMessage[],
			});
			return script[Math.min(decision++, script.length - 1)]!;
		},
	});
	return { requests, results, events };
}

const names = (request: Request) => request.tools.map((tool) => tool.function.name);
const botEvent = (events: ComputerUseEvent[]) => events.find((event) => event.type === "bot-proposal");
const proposal = {
	name: "Estoquinho",
	description: "Acompanha o estoque e avisa quando um item está acabando.",
	color: "blue",
	shape: "hex",
	first_task: "Liste os itens com estoque abaixo de 5.",
};

describe("propose_bot", () => {
	it("devolve o card pendente e não cria nenhum bot", async () => {
		const { events, results } = await run({ script: [turn(call("c1", "propose_bot", proposal)), done] });
		expect(results[0]?.ok).toBe(true);
		const event = botEvent(events);
		expect(event).toMatchObject({ type: "bot-proposal", name: "Estoquinho", status: "pending", color: "#1084FE", shape: "hex", firstTask: "Liste os itens com estoque abaixo de 5." });
		expect(persistConversationCardFromEvent).toHaveBeenCalledTimes(1);
		expect(bots.rows).toHaveLength(1);
	});

	it("carrega só no chat com o usuário: some em rotina, webhook e conversa entre bots", async () => {
		const chat = await run({ script: [done] });
		expect(chat.requests[0]!.messages[0]!.content).toContain("propose_bot");
		for (const origin of ["routine", "webhook", "bot", "event"]) {
			const other = await run({ origin, script: [turn(call("c1", "propose_bot", proposal)), done] });
			expect(names(other.requests[0]!)).not.toContain("propose_bot");
			expect(String(other.requests[0]!.messages[0]!.content)).not.toContain("propose_bot");
			expect(other.results[0]?.ok).toBe(false);
			expect(botEvent(other.events)).toBeUndefined();
		}
		expect(bots.rows).toHaveLength(1);
	});

	it("pedido vago (\"cria um agente pra mim\") recusa e manda perguntar com propose_questionnaire", async () => {
		const { results, events } = await run({ message: "cria um agente pra mim", script: [turn(call("c1", "propose_bot", proposal)), done] });
		expect(results[0]?.ok).toBe(false);
		expect(results[0]?.summary).toContain("propose_questionnaire");
		expect(botEvent(events)).toBeUndefined();
		expect(persistConversationCardFromEvent).not.toHaveBeenCalled();
	});

	it("no máximo uma proposta por turno", async () => {
		const { results, events } = await run({
			script: [turn(call("c1", "propose_bot", proposal), call("c2", "propose_bot", { ...proposal, name: "Outro" })), done],
		});
		expect(results.map((item) => item.ok)).toEqual([true, false]);
		expect(events.filter((event) => event.type === "bot-proposal")).toHaveLength(1);
	});

	it("skills iniciais precisam existir na conta; cor e forma seguem as opções do formulário", async () => {
		docs.rows.push({ id: "d1", userId: USER, botId: null, name: "resumo-semanal", description: "d", body: "b", tools: [], enabled: true, status: "active", revision: 1, createdBy: "user", createdAt: new Date(), updatedAt: new Date() });
		const unknown = await run({ script: [turn(call("c1", "propose_bot", { ...proposal, skills: ["nao-existe"] })), done] });
		expect(unknown.results[0]?.ok).toBe(false);
		expect(unknown.results[0]?.summary).toContain("resumo-semanal");
		const badColor = await run({ script: [turn(call("c1", "propose_bot", { ...proposal, color: "neon" })), done] });
		expect(badColor.results[0]?.ok).toBe(false);
		const ok = await run({ script: [turn(call("c1", "propose_bot", { ...proposal, skills: ["resumo-semanal"] })), done] });
		expect(ok.results[0]?.ok).toBe(true);
		expect(botEvent(ok.events)).toMatchObject({ skills: ["resumo-semanal"] });
	});
});

describe("isBareBotCreateRequest", () => {
	it("pega só o pedido vago", () => {
		expect(isBareBotCreateRequest("cria um agente pra mim")).toBe(true);
		expect(isBareBotCreateRequest("Quero um novo bot")).toBe(true);
		expect(isBareBotCreateRequest("crie um agente que resume meus e-mails toda manhã")).toBe(false);
		expect(isBareBotCreateRequest("sim, pode criar")).toBe(false);
		expect(isBareBotCreateRequest('{"event":"questionnaire-answered","answers":{"para":"criar agente"}}')).toBe(false);
		expect(isBareBotCreateRequest(undefined)).toBe(false);
	});
});
