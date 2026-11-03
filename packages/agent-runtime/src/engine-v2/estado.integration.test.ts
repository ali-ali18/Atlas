/**
 * Motor v2: estado explícito por passo ("Run state"). Run de ponta a ponta com LLM e tools mockados: o bloco vai na cópia
 * enviada a partir do passo 2 (depois de uma tool), não aparece no passo 1 nem em chat sem tools, e nunca entra no histórico salvo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmMessage, LlmToolCall } from "@workspace/llm";
import type { AgentRunCheckpoint } from "@workspace/shared";
import { runEngineV2, type EngineV2Options } from "./run.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => ({ description: "Bot configurado." })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	upsertTaskListCard: vi.fn(async () => undefined),
	getConversationUntrustedAt: vi.fn(async () => null),
	markConversationUntrusted: vi.fn(async () => undefined),
	markMcpTaskGrantsUntrusted: vi.fn(async () => undefined),
}));

vi.mock("../web-native.js", () => ({
	nativeWebSearch: vi.fn(async () => [{ title: "Fonte A", url: "https://a.example.com/p", snippet: "preço A", source: "mock" }]),
	nativeWebExtract: vi.fn(async ({ urls }: { urls: string[] }) => urls.map((url) => ({ url, title: `Página ${url}`, fetchedAt: "2026-11-03T12:00:00Z", content: "Preço: R$ 10", truncated: false }))),
}));

let seq = 0;
const call = (name: string, args: Record<string, unknown> = {}): LlmToolCall => ({ id: `s${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const turn = (calls: LlmToolCall[]): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: null, tool_calls: calls }, finishReason: "tool_calls" });
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content }, finishReason: "stop" });
const textOf = (message: LlmMessage): string => (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""));

const GOAL = "Compare o preço do produto nas fontes e me diga a mais barata";

async function run(script: CompleteChatWithToolsResult[], options: Partial<EngineV2Options> = {}, content = GOAL) {
	const sent: LlmMessage[][] = [];
	const checkpoints: AgentRunCheckpoint[] = [];
	const queue = [...script];
	const result = await runEngineV2(
		{
			manager: {} as unknown as SandboxManager,
			getSessionId: async () => "session-1",
			apiKey: "test",
			model: "m",
			runId: "run-state",
			userId: "user-a",
			botId: "bot-a",
			conversationId: "conv-1",
			origin: "chat",
			humanTurn: true,
			messages: [{ role: "user", content }],
			timeZone: "America/Sao_Paulo",
			onEvent: () => undefined,
			onCheckpoint: async (checkpoint) => {
				checkpoints.push(JSON.parse(JSON.stringify(checkpoint)) as AgentRunCheckpoint);
			},
			streamChat: async (params: CompleteChatWithToolsParams) => {
				sent.push(params.messages);
				const next = queue.shift();
				if (!next) throw new Error("roteiro acabou");
				return next;
			},
		},
		{ profile: "chat", promotable: false, ...options },
	);
	return { result, sent, checkpoints };
}

const stateOf = (messages: LlmMessage[]) => messages.map(textOf).filter((text) => text.includes("Run state (automatic"));

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("integração: estado do run por passo", () => {
	it("passo 2 recebe o bloco (pedido, última tool, tarefas); o passo 1 e o histórico salvo não", async () => {
		const { result, sent, checkpoints } = await run([
			turn([call("update_task_list", { items: [{ content: "Buscar fontes", status: "in_progress" }, { content: "Responder", status: "pending" }] })]),
			turn([call("web_search", { query: "preço do produto" })]),
			turn([call("update_task_list", { items: [{ content: "Buscar fontes", status: "completed" }, { content: "Responder", status: "completed" }] })]),
			say("A fonte A é a mais barata."),
		]);
		expect(result.stop).toEqual({ reason: "answered" });
		expect(sent).toHaveLength(4);
		// Passo 1: nada.
		expect(stateOf(sent[0]!)).toHaveLength(0);
		// Passo 2: depois do update_task_list.
		const second = stateOf(sent[1]!);
		expect(second).toHaveLength(1);
		expect(second[0]).toContain(`Goal: "${GOAL}"`);
		expect(second[0]).toContain("Last step: update_task_list ok");
		expect(second[0]).toContain('Tasks: 2 open of 2; current "Buscar fontes"');
		// Passo 3: reflete a tool mais recente, e só há UM bloco (o do passo anterior não se acumula).
		const third = stateOf(sent[2]!);
		expect(third).toHaveLength(1);
		expect(third[0]).toContain("Last step: web_search ok");
		// A camada vai por último, depois do histórico, e é contexto automático de usuário (não sistema).
		const last = sent[2]!.at(-1)!;
		expect(last.role).toBe("user");
		expect(textOf(last)).toContain("Run state");
		// Nunca persiste: nem no histórico canônico (checkpoint) nem nas mensagens do passo seguinte ao fim do run.
		for (const checkpoint of checkpoints) expect(JSON.stringify(checkpoint)).not.toContain("Run state (automatic");
		expect(sent[0]!.map(textOf).join("\n")).not.toContain("Run state");
	});

	it("chat sem tools ('Bom dia') e pedido de uma tool só no passo 1 ficam intocados", async () => {
		const plain = await run([say("Bom dia!")], {}, "Bom dia");
		expect(plain.sent).toHaveLength(1);
		expect(stateOf(plain.sent[0]!)).toHaveLength(0);
	});

	it("falha da tool aparece no bloco do passo seguinte, em uma linha e citada", async () => {
		const { sent } = await run([turn([call("web_extract", { urls: [] })]), say("Não consegui ler a fonte.")]);
		const block = stateOf(sent[1]!)[0]!;
		expect(block).toMatch(/Last step: web_extract (ok|FAILED)/);
		expect(block.length).toBeLessThanOrEqual(520);
	});
});
