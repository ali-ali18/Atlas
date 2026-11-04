import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { saveSkillPendingIntentIfFree } from "@workspace/db";
import type { AgentRunCheckpoint, ComputerUseEvent } from "@workspace/shared";
import { AgentRunPausedError } from "../errors.js";
import type { ComputerUseParams } from "../run-types.js";
import { runEngineV3, type EngineV3Options } from "./loop.js";
import { OWNER_BUSY_NOTE, OWNER_STOPPED_NOTE } from "./limits.js";

/** O executor real precisa de banco/VM: toda tool devolve um resultado novo (a rede de repetição não entra aqui). */
const executeTool = vi.hoisted(() => vi.fn(async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => ({ summary: `${name} ${JSON.stringify(args)} ok` })));
vi.mock("../tools/registry/execute.js", () => ({ executeTool }));
vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => ({ description: "configurado" })),
	getConversationUntrustedAt: vi.fn(async () => null),
	markConversationUntrusted: vi.fn(async () => undefined),
	markMcpTaskGrantsUntrusted: vi.fn(async () => undefined),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	upsertTaskListCard: vi.fn(async () => undefined),
	saveSkillPendingIntentIfFree: vi.fn(async () => true),
	takeToolCallApproval: vi.fn(async () => null),
}));

const TOOL = "current_time";
const step = (index: number): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id: `c${index}`, type: "function", function: { name: TOOL, arguments: JSON.stringify({ timezone: `Zone/${index}` }) } } satisfies LlmToolCall] },
	finishReason: "tool_calls",
	usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.004 },
});
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content }, finishReason: "stop" });
const textOf = (params: CompleteChatWithToolsParams) => params.messages.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""))).join("\n");

async function runV3(script: CompleteChatWithToolsResult[], extra: Partial<ComputerUseParams> = {}, options: EngineV3Options = {}) {
	const events: ComputerUseEvent[] = [];
	const checkpoints: AgentRunCheckpoint[] = [];
	const requests: CompleteChatWithToolsParams[] = [];
	const queue = [...script];
	let error: unknown;
	let result;
	try {
		result = await runEngineV3(
			{
				manager: {} as SandboxManager,
				getSessionId: async () => "s",
				sandboxEnabled: false,
				model: "m",
				apiKey: "k",
				runId: "run-r1",
				userId: "user-a",
				botId: "bot-a",
				conversationId: "conv-rotina",
				origin: "routine",
				humanTurn: false,
				messages: [{ role: "user", content: "Confira a hora em cada fuso" }],
				onEvent: (event) => { events.push(event); },
				onCheckpoint: async (snapshot) => { checkpoints.push(JSON.parse(JSON.stringify(snapshot)) as AgentRunCheckpoint); },
				streamChat: async (params) => {
					requests.push(params);
					const next = queue.shift();
					if (!next) throw new Error("roteiro acabou");
					return next;
				},
				...extra,
			},
			options,
		);
	} catch (caught) {
		error = caught;
	}
	const cards = events.filter((event): event is Extract<ComputerUseEvent, { type: "confirm" }> => event.type === "confirm");
	return { result, error, events, cards, checkpoints, requests };
}

const steps = (count: number, from = 0) => Array.from({ length: count }, (_, index) => step(from + index));
const resumeWith = (checkpoint: AgentRunCheckpoint, outcome?: "continue" | "stop"): Partial<ComputerUseParams> => {
	const engineV3 = checkpoint.engineV3 as Record<string, unknown>;
	const wait = engineV3.limitWait as Record<string, unknown>;
	return { restoredCheckpoint: { ...checkpoint, engineV3: { ...engineV3, limitWait: { ...wait, ...(outcome ? { outcome } : {}) } } } };
};

beforeEach(() => {
	executeTool.mockClear();
	vi.mocked(saveSkillPendingIntentIfFree).mockClear();
});

describe("rotina no limite de passos: guarda o ponto e pergunta ao dono", () => {
	it("para no passo 40 com checkpoint e cartão \"Continuo?\"; o 41º passo não roda", async () => {
		const { error, cards, checkpoints, requests } = await runV3([...steps(40), step(99)]);
		expect(error).toBeInstanceOf(AgentRunPausedError);
		expect(requests).toHaveLength(40);
		expect(executeTool).toHaveBeenCalledTimes(40);
		expect(cards).toEqual([
			expect.objectContaining({ confirmId: "confirm-limit1-run-r1", title: "Cheguei no limite de 40 passos. Continuo?", confirmLabel: "Continuar", cancelLabel: "Agora não" }),
		]);
		expect(cards[0]!.description).not.toMatch(/tool|checkpoint|step/i);
		const last = checkpoints.at(-1)!;
		expect(last).toMatchObject({ engine: "v3", nextStepIndex: 40, engineV3: { limitWait: { cardId: "confirm-limit1-run-r1", kind: "steps", steps: 40 } } });
		expect(saveSkillPendingIntentIfFree).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conv-rotina", payload: expect.objectContaining({ action: "step-limit", confirmId: "confirm-limit1-run-r1", stepLimit: { runId: "run-r1" } }) }));
	});

	it("pedido do dono já esperando na conversa: não sobrescreve, não estaciona; resposta final honesta dizendo isso", async () => {
		vi.mocked(saveSkillPendingIntentIfFree).mockResolvedValueOnce(false);
		const { error, cards, requests, result, checkpoints } = await runV3([...steps(40), say("Fiz 40 conferências; um pedido seu já está aguardando.")]);
		expect(error).toBeUndefined();
		expect(cards).toHaveLength(0);
		expect(requests.at(-1)!.toolChoice).toBe("none");
		expect(textOf(requests.at(-1)!)).toContain(OWNER_BUSY_NOTE);
		expect(result).toMatchObject({ stop: { reason: "budget_steps", detail: "v3_steps_unattended:owner_busy" } });
		expect((checkpoints.at(-1)?.engineV3 as Record<string, unknown> | undefined)?.limitWait).toBeUndefined();
	});

	it("Continuar retoma do checkpoint com mais 40 passos e para de novo no 80", async () => {
		const first = await runV3(steps(40));
		const resumed = await runV3([...steps(40, 40), step(99)], resumeWith(first.checkpoints.at(-1)!, "continue"));
		expect(textOf(resumed.requests[0]!)).toContain("The owner said to continue after the limit: you have 40 more steps");
		// O histórico do checkpoint voltou inteiro (os 40 resultados de antes estão no pedido).
		expect(resumed.requests[0]!.messages.filter((message) => message.role === "tool")).toHaveLength(40);
		expect(resumed.error).toBeInstanceOf(AgentRunPausedError);
		expect(resumed.requests).toHaveLength(40);
		expect(resumed.cards.map((card) => card.confirmId)).toEqual(["confirm-limit2-run-r1"]);
		expect(resumed.checkpoints.at(-1)).toMatchObject({ nextStepIndex: 80, engineV3: { limitGrant: { steps: 40, waits: 2 }, limitWait: { cardId: "confirm-limit2-run-r1" } } });
	});

	it("Continuar e terminar antes do novo limite responde normalmente", async () => {
		const first = await runV3(steps(40));
		const resumed = await runV3([step(40), say("Conferi todos os fusos.")], resumeWith(first.checkpoints.at(-1)!, "continue"));
		expect(resumed.error).toBeUndefined();
		expect(resumed.result).toMatchObject({ text: "Conferi todos os fusos.", stop: { reason: "answered" } });
		expect((resumed.checkpoints.at(-1)!.engineV3 as Record<string, unknown>).limitWait).toBeUndefined();
	});

	it("Agora não: uma resposta final sem tools contando o que ficou feito; nada mais executa", async () => {
		const first = await runV3(steps(40));
		executeTool.mockClear();
		const stopped = await runV3([say("Conferi 40 fusos; faltaram os demais.")], resumeWith(first.checkpoints.at(-1)!, "stop"));
		expect(stopped.requests).toHaveLength(1);
		expect(stopped.requests[0]!.toolChoice).toBe("none");
		expect(textOf(stopped.requests[0]!)).toContain(OWNER_STOPPED_NOTE);
		expect(executeTool).not.toHaveBeenCalled();
		expect(stopped.result).toMatchObject({ text: "Conferi 40 fusos; faltaram os demais.", stop: { reason: "budget_steps", detail: "v3_steps_unattended:owner_stopped" } });
	});

	it("retomada sem decisão gravada vale como Agora não (nunca segue gastando sozinha)", async () => {
		const first = await runV3(steps(40));
		const stopped = await runV3([say("Parei no limite.")], resumeWith(first.checkpoints.at(-1)!));
		expect(stopped.requests[0]!.toolChoice).toBe("none");
		expect(stopped.result).toMatchObject({ stop: { detail: "v3_steps_unattended:owner_stopped" } });
	});

	it("limite próprio da rotina (5 passos) vale no lugar dos 40; em chat ele é ignorado", async () => {
		const routine = await runV3([...steps(5), step(99)], { routineLimits: { maxSteps: 5 } });
		expect(routine.error).toBeInstanceOf(AgentRunPausedError);
		expect(routine.cards[0]!.title).toBe("Cheguei no limite de 5 passos. Continuo?");
		const chat = await runV3([...steps(6), say("ok")], { origin: "chat", humanTurn: true, routineLimits: { maxSteps: 5 } });
		expect(chat.error).toBeUndefined();
		expect(chat.result).toMatchObject({ stop: { reason: "answered" } });
	});

	it("chat com pessoa passa de 40 passos sem cartão", async () => {
		const { result, cards, error } = await runV3([...steps(45), say("Pronto.")], { origin: "chat", humanTurn: true });
		expect(error).toBeUndefined();
		expect(cards).toHaveLength(0);
		expect(result).toMatchObject({ text: "Pronto.", stop: { reason: "answered" } });
	});
});

describe("rotina com teto em US$", () => {
	it("teto configurado na rotina: para quando o gasto chega nele, com o mesmo cartão", async () => {
		// Cada passo custa US$ 0,004: com teto de 0,01 o 3º passo já não começa.
		const { error, cards, requests, checkpoints } = await runV3([...steps(3), say("x")], { routineLimits: { maxCostUsd: 0.01 } });
		expect(error).toBeInstanceOf(AgentRunPausedError);
		expect(requests).toHaveLength(3);
		expect(cards[0]!.title).toBe("Cheguei no limite de US$ 0,01 desta execução. Continuo?");
		expect(checkpoints.at(-1)).toMatchObject({ engineV3: { limitWait: { kind: "cost", costUsd: 0.01 } } });
	});

	it("Continuar no teto de US$ soma o mesmo valor de novo", async () => {
		const first = await runV3(steps(3), { routineLimits: { maxCostUsd: 0.01 } });
		const resumed = await runV3([step(3), step(4), step(5)], { routineLimits: { maxCostUsd: 0.01 }, ...resumeWith(first.checkpoints.at(-1)!, "continue") });
		expect(textOf(resumed.requests[0]!)).toContain("US$ 0.01 more to spend");
		expect(resumed.error).toBeInstanceOf(AgentRunPausedError);
		expect(resumed.checkpoints.at(-1)).toMatchObject({ engineV3: { limitGrant: { usd: 0.01 } } });
	});

	it("sem teto configurado, gasto nenhum para a rotina antes dos passos", async () => {
		const { error, result, cards } = await runV3([...steps(10), say("Pronto.")]);
		expect(error).toBeUndefined();
		expect(cards).toHaveLength(0);
		expect(result).toMatchObject({ stop: { reason: "answered" } });
	});

	it("teto da conta (budget) também estaciona sem humano; vale o menor entre conta e rotina", async () => {
		const account = await runV3([...steps(3), say("x")], { budget: { maxCostUsd: 0.008 }, routineLimits: { maxCostUsd: 5 } });
		expect(account.error).toBeInstanceOf(AgentRunPausedError);
		expect(account.cards[0]!.title).toContain("US$ 0,01");
	});
});
