import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { getBotProfile } from "@workspace/db";
import type { AgentRunCheckpoint, StepTelemetry } from "@workspace/shared";
import { buildMcpToolset } from "./mcp/registry.js";
import type { McpRuntime } from "./mcp/runtime.js";
import { runComputerUse, type RuntimeStepRecord } from "./computer-use.js";
import { AgentRunLoopDetectedError } from "./errors.js";
import type { JevAsk, JevRuntime } from "./jev/decide.js";
import type { ModelTiersRuntime } from "./model-tiers.js";

/**
 * Modo Automático: modelos por dificuldade. Classificação no início do run e
 * subida de nível quando o run trava. LLM e Jev mockados; nada de rede.
 */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		loadAutonomyContext: vi.fn(async () => ({ accountRaw: null, botRaw: null, botName: "Taldo" })),
	};
});

const toolCall = (id: string, name: string, args: Record<string, unknown>): CompleteChatWithToolsResult => ({
	model: "served",
	message: {
		role: "assistant",
		content: null,
		tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
	},
});
const say = (content: string): CompleteChatWithToolsResult => ({ model: "served", message: { role: "assistant", content } });

const firecrawl = {
	id: "conn-fc",
	slug: "firecrawl",
	name: "Firecrawl",
	disabledTools: [],
	tools: ["firecrawl_search"].map((name) => ({
		name,
		description: `Firecrawl ${name}`,
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
	})),
};

const searches = (n: number) => Array.from({ length: n }, (_, i) => toolCall(`c${i}`, "mcp__firecrawl__firecrawl_search", { query: `consulta ${i}` }));
const TIERS: ModelTiersRuntime = {
	tiers: { easy: ["easy/main", "easy/backup"], medium: ["med/main"], hard: ["hard/main", "hard/backup"] },
};

const stuckJev = (probability: number, extra: Record<string, number> = {}): JevRuntime => {
	const ask: JevAsk = vi.fn(async ({ questions }) => ({
		model: "jev",
		answers: Object.fromEntries(Object.keys(questions).map((key) => [key, extra[key] ?? (key === "stuck" ? probability : 0)])),
		durationMs: 1,
	}));
	return { ask, modes: { stuck: "on" } };
};

async function run(input: {
	text: string;
	modelTiers?: ModelTiersRuntime;
	calls: Array<CompleteChatWithToolsResult>;
	jev?: JevRuntime;
	mcpCall?: () => { ok: boolean; text: string; truncated: boolean };
	restoredCheckpoint?: AgentRunCheckpoint;
	fallbackModels?: string[];
	codingModel?: string;
}) {
	let n = 0;
	const mcp: McpRuntime = {
		toolset: buildMcpToolset([firecrawl], {}),
		call: vi.fn(async () => (input.mcpCall ?? (() => ({ ok: true, text: `página nova ${n++}`, truncated: false })))()) as unknown as McpRuntime["call"],
	};
	const calls: CompleteChatWithToolsParams[] = [];
	const steps: RuntimeStepRecord[] = [];
	const checkpoints: AgentRunCheckpoint[] = [];
	const queue = [...input.calls];
	let error: unknown;
	let result: Awaited<ReturnType<typeof runComputerUse>> | undefined;
	try {
		result = await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => {
				throw new Error("nao deve criar sessao");
			},
			sandboxEnabled: false,
			model: "base/model",
			fallbackModels: input.fallbackModels ?? ["base/backup"],
			modelTiers: input.modelTiers,
			codingModel: input.codingModel,
			apiKey: "test",
			messages: [{ role: "user", content: input.text }],
			botId: "bot-1",
			userId: "user-1",
			conversationId: "conv-tiers",
			runId: "run-tiers",
			origin: "chat",
			maxSteps: 30,
			mcp,
			jev: input.jev,
			restoredCheckpoint: input.restoredCheckpoint,
			getModelContextLength: async (id) => (id === "hard/main" ? 500_000 : null),
			onStep: async (step) => {
				steps.push(step);
			},
			onCheckpoint: async (checkpoint) => {
				checkpoints.push(JSON.parse(JSON.stringify(checkpoint)));
			},
			onEvent: () => {},
			streamChat: async (params) => {
				calls.push(JSON.parse(JSON.stringify(params)));
				const next = queue.shift();
				if (!next) throw new Error("LLM extra");
				return { ...next, model: params.model };
			},
		});
	} catch (caught) {
		error = caught;
	}
	const modelSteps = steps.filter((step) => step.type === "model");
	const telemetry = modelSteps.map((step) => step.telemetry as StepTelemetry | undefined);
	return { calls, steps, telemetry, checkpoints, error, result };
}

beforeEach(() => {
	vi.mocked(getBotProfile).mockResolvedValue(null);
});

describe("modo Automático: modelo do nível no início do run", () => {
	it("pedido de conversa usa o modelo e as reservas do nível Fácil", async () => {
		const { calls, telemetry, result } = await run({ text: "oi, tudo bem?", modelTiers: TIERS, calls: [say("Olá!")] });
		expect(calls[0]?.model).toBe("easy/main");
		expect(calls[0]?.fallbackModels).toEqual(["easy/backup"]);
		expect(telemetry[0]).toMatchObject({ tier: "easy", tierSource: "rules" });
		expect(result?.model).toBe("easy/main");
	});

	it("pedido de código usa o nível Difícil e a janela de contexto do novo modelo", async () => {
		const { calls, telemetry } = await run({ text: "corrige o bug no repositório e abre um pull request", modelTiers: TIERS, calls: [say("Feito.")] });
		expect(calls[0]?.model).toBe("hard/main");
		expect(calls[0]?.fallbackModels).toEqual(["hard/backup"]);
		expect(telemetry[0]?.tier).toBe("hard");
	});

	it("nível vazio herda o modelo do run e as reservas (nada muda sem configuração)", async () => {
		const { calls } = await run({ text: "oi", modelTiers: { tiers: { hard: ["hard/main"] } }, calls: [say("Olá!")] });
		expect(calls[0]?.model).toBe("base/model");
		expect(calls[0]?.fallbackModels).toEqual(["base/backup"]);
	});

	it("sem modelTiers o run segue o modelo do pedido, sem campos de nível", async () => {
		const { calls, telemetry } = await run({ text: "corrige o bug no repositório", calls: [say("Feito.")] });
		expect(calls[0]?.model).toBe("base/model");
		expect(calls[0]?.fallbackModels).toEqual(["base/backup"]);
		expect(telemetry[0]?.tier).toBeUndefined();
	});

	it("com 'Classificar com o revisor', o veredito do revisor decide; a falha cai nas regras", async () => {
		const reviewer = stuckJev(0, { hard: 0.95, medium: 0.9 });
		const viaReviewer = await run({ text: "oi", modelTiers: { ...TIERS, classifyWithReviewer: true }, jev: reviewer, calls: [say("ok")] });
		expect(viaReviewer.calls[0]?.model).toBe("hard/main");
		expect(viaReviewer.telemetry[0]).toMatchObject({ tier: "hard", tierSource: "reviewer" });

		const broken: JevRuntime = { ask: vi.fn(async () => { throw new Error("fora do ar"); }) };
		const fallback = await run({ text: "oi", modelTiers: { ...TIERS, classifyWithReviewer: true }, jev: broken, calls: [say("ok")] });
		expect(fallback.calls[0]?.model).toBe("easy/main");
		expect(fallback.telemetry[0]).toMatchObject({ tier: "easy", tierSource: "rules" });
	});

	it("sem 'Classificar com o revisor' o revisor não é chamado para classificar", async () => {
		const jev = stuckJev(0, { hard: 1 });
		await run({ text: "oi", modelTiers: TIERS, jev, calls: [say("ok")] });
		expect(jev.ask).not.toHaveBeenCalled();
	});

	it("o modelo para código, quando entra, vence o nível", async () => {
		const { calls } = await run({ text: "oi", modelTiers: TIERS, codingModel: "coding/model", calls: [say("ok")] });
		expect(calls[0]?.model).toBe("easy/main");
	});

	it("retomada reusa o nível do checkpoint em vez de classificar de novo", async () => {
		const { calls, telemetry } = await run({
			text: "oi",
			modelTiers: TIERS,
			restoredCheckpoint: { version: 1, messages: [{ role: "user", content: "oi" }], nextStepIndex: 0, modelTier: "hard" },
			calls: [say("ok")],
		});
		expect(calls[0]?.model).toBe("hard/main");
		expect(telemetry[0]?.tier).toBe("hard");
		expect(telemetry[0]?.tierSource).toBeUndefined();
	});
});

describe("modo Automático: subir de nível quando o run trava", () => {
	const text = "pesquise tudo sobre o assunto";

	it("revisor diz que travou: sobe para o nível acima e continua com o novo modelo", async () => {
		const jev = stuckJev(0.95);
		const { calls, telemetry, error, result, checkpoints } = await run({
			text,
			modelTiers: TIERS,
			jev,
			calls: [...searches(8), say("Concluí com o modelo mais forte.")],
		});
		expect(error).toBeUndefined();
		expect(result?.text).toBe("Concluí com o modelo mais forte.");
		// Passos 0 a 7 no nível Média; o 8º decide no Difícil.
		expect(calls.slice(0, 8).every((call) => call.model === "med/main")).toBe(true);
		expect(calls[8]?.model).toBe("hard/main");
		expect(calls[8]?.fallbackModels).toEqual(["hard/backup"]);
		expect(result?.model).toBe("hard/main");
		expect(telemetry[8]).toMatchObject({ tier: "hard", escalation: { from: "medium", to: "hard", reason: "stuck" } });
		expect(telemetry[9 - 1]?.escalation).toBeDefined();
		expect(telemetry.filter((entry) => entry?.escalation)).toHaveLength(1);
		const last = checkpoints.at(-1);
		expect(last?.modelTier).toBe("hard");
		expect(last?.modelEscalations).toEqual([{ from: "medium", to: "hard", reason: "stuck", step: 8 }]);
		// O modelo novo recebe o aviso de que assumiu o run.
		const lastMessages = JSON.stringify(calls[8]?.messages);
		expect(lastMessages).toContain("A stronger model took over this run");
	});

	it("no Difícil, ou sem nível acima com modelo diferente, para como antes", async () => {
		const sameAbove: ModelTiersRuntime = { tiers: { medium: ["med/main"], hard: ["med/main"] } };
		const { error } = await run({
			text,
			modelTiers: sameAbove,
			jev: stuckJev(0.95),
			calls: [...searches(8), say("Resumo parcial.")],
		});
		expect(error).toBeInstanceOf(AgentRunLoopDetectedError);
		expect((error as AgentRunLoopDetectedError).finalText).toBe("Resumo parcial.");
	});

	it("já no Difícil e travado: para com a mensagem de hoje", async () => {
		const { error, calls } = await run({
			text: "corrige o bug no repositório",
			modelTiers: TIERS,
			jev: stuckJev(0.95),
			calls: [...searches(8), say("Resumo parcial.")],
		});
		expect(error).toBeInstanceOf(AgentRunLoopDetectedError);
		expect(calls.every((call) => call.model === "hard/main")).toBe(true);
	});

	it("sem modo Automático, travar continua parando o run (sem troca de modelo)", async () => {
		const { error, calls } = await run({ text, jev: stuckJev(0.95), calls: [...searches(8), say("Resumo parcial.")] });
		expect(error).toBeInstanceOf(AgentRunLoopDetectedError);
		expect(calls.every((call) => call.model === "base/model")).toBe(true);
	});

	it("a mesma ferramenta falhando 3 vezes seguidas sobe de nível uma vez", async () => {
		const { calls, telemetry, error, result } = await run({
			text,
			modelTiers: TIERS,
			mcpCall: () => ({ ok: false, text: "erro do conector", truncated: false }),
			calls: [...searches(3), say("Segui sem a ferramenta.")],
		});
		expect(error).toBeUndefined();
		expect(calls.slice(0, 3).every((call) => call.model === "med/main")).toBe(true);
		expect(calls[3]?.model).toBe("hard/main");
		expect(telemetry[3]?.escalation).toEqual({ from: "medium", to: "hard", reason: "tool_failures" });
		expect(result?.model).toBe("hard/main");
	});

	it("a mesma ferramenta voltando vazia 3 vezes seguidas também sobe de nível", async () => {
		const { calls, telemetry } = await run({
			text,
			modelTiers: TIERS,
			mcpCall: () => ({ ok: true, text: JSON.stringify({ data: [] }), truncated: false }),
			calls: [...searches(3), say("Nada encontrado.")],
		});
		expect(calls[3]?.model).toBe("hard/main");
		expect(telemetry[3]?.escalation?.reason).toBe("tool_failures");
	});

	it("resultados bons não sobem de nível", async () => {
		const { calls } = await run({ text, modelTiers: TIERS, calls: [...searches(4), say("Pronto.")] });
		expect(calls.every((call) => call.model === "med/main")).toBe(true);
	});
});
