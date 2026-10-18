import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { stepTelemetryOf } from "@workspace/shared";
import { runComputerUse, type RuntimeStepRecord } from "./computer-use.js";
import { buildMcpToolset } from "./mcp/registry.js";
import { createJevTelemetryCollector } from "./telemetry/jev-telemetry.js";

const SECRET_PROMPT = "SEGREDO-DO-USUARIO-123";
const SECRET_TOOL_ARG = "https://example.com/?token=SEGREDO-NA-URL";

const modelTurn = (
	extra: Partial<CompleteChatWithToolsResult>,
	toolCall = false,
): CompleteChatWithToolsResult => ({
	model: "served/model",
	message: toolCall
		? {
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "navigate", arguments: JSON.stringify({ url: SECRET_TOOL_ARG }) },
					},
				],
			}
		: { role: "assistant", content: "RESPOSTA-SECRETA-DO-MODELO" },
	...extra,
});

async function runWithTelemetry() {
	const steps: RuntimeStepRecord[] = [];
	const queue = [
		modelTurn(
			{
				timing: {
					totalMs: 1200,
					ttftMs: 340,
					attempts: 2,
					retryReasons: ["rate_limit"],
					requestedModel: "requested/model",
					servedModel: "served/model",
				},
				usage: {
					promptTokens: 1000,
					completionTokens: 50,
					totalTokens: 1050,
					cachedTokens: 800,
					cacheWriteTokens: 120,
					costUsd: 0.002,
				},
			},
			true,
		),
		modelTurn({
			usage: { promptTokens: 1100, completionTokens: 20, totalTokens: 1120 },
		}),
	];
	const manager = {
		execNavigate: async () => ({ url: "https://example.com", title: "Example" }),
	} as unknown as SandboxManager;
	const result = await runComputerUse({
		manager,
		getSessionId: async () => "session-1",
		model: "requested/model",
		apiKey: "test",
		messages: [{ role: "user", content: `abra o site ${SECRET_PROMPT}` }],
		language: "en-US",
		runId: "run-tel",
		maxSteps: 4,
		onEvent: () => undefined,
		streamChat: async (_params, handlers) => {
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			handlers?.onDelta?.("x");
			return next;
		},
		onStep: async (step) => {
			steps.push(step);
		},
	});
	return { steps, result };
}

describe("telemetria por passo no runtime", () => {
	it("o passo do modelo carrega modelMs/ttftMs/servedModel/cacheWriteTokens", async () => {
		const { steps, result } = await runWithTelemetry();
		const model0 = steps.find((s) => s.type === "model" && s.decisionIndex === 0);
		expect(model0?.durationMs).toBe(1200);
		expect(model0?.costUsd).toBe(0.002);
		expect(model0?.telemetry).toMatchObject({
			modelMs: 1200,
			ttftMs: 340,
			llmAttempts: 2,
			retryReasons: ["rate_limit"],
			requestedModel: "requested/model",
			servedModel: "served/model",
			promptTokens: 1000,
			completionTokens: 50,
			cachedTokens: 800,
			cacheWriteTokens: 120,
			costUsd: 0.002,
		});
		// o uso do run agora preserva cacheWriteTokens
		expect(result.usage.cacheWriteTokens).toBe(120);
	});

	it("sem timing do llm, mede modelMs e usa o 1o delta como TTFT", async () => {
		const { steps } = await runWithTelemetry();
		const model1 = steps.find((s) => s.type === "model" && s.decisionIndex === 1);
		expect(model1?.telemetry?.modelMs).toBeGreaterThanOrEqual(0);
		expect(model1?.telemetry?.ttftMs).toBeGreaterThanOrEqual(0);
		expect(model1?.telemetry?.servedModel).toBe("served/model");
		// custo desconhecido: ausente, não zero
		expect(model1?.telemetry).not.toHaveProperty("costUsd");
		expect(model1).not.toHaveProperty("costUsd");
	});

	it("tool_result traz toolMs e o fechamento da decisão traz o overhead", async () => {
		const { steps } = await runWithTelemetry();
		const toolResult = steps.find((s) => s.type === "tool_result");
		expect(toolResult?.telemetry?.toolName).toBe("navigate");
		expect(toolResult?.telemetry?.toolMs).toBeGreaterThanOrEqual(0);
		expect(toolResult?.durationMs).toBe(toolResult?.telemetry?.toolMs);
		const closing = steps.find((s) => s.type === "checkpoint" && s.subIndex === 99);
		expect(closing?.telemetry?.overheadMs).toBeGreaterThanOrEqual(0);
		expect(closing?.telemetry?.stepMs).toBeGreaterThanOrEqual(0);
	});

	it("redação: a telemetria não contém conteúdo de mensagem, args nem resultado", async () => {
		const { steps } = await runWithTelemetry();
		const telemetries = steps.flatMap((s) => (s.telemetry ? [s.telemetry] : []));
		expect(telemetries.length).toBeGreaterThan(2);
		const dump = JSON.stringify(telemetries);
		for (const secret of [SECRET_PROMPT, "SEGREDO-NA-URL", "RESPOSTA-SECRETA", "Example", "example.com"]) {
			expect(dump).not.toContain(secret);
		}
		// o extrator do summarizer só enxerga o campo telemetry
		const model0 = steps.find((s) => s.type === "model" && s.decisionIndex === 0)!;
		expect(
			JSON.stringify(stepTelemetryOf({ outputJson: { ...(model0.outputJson as object), telemetry: model0.telemetry } })),
		).not.toContain("RESPOSTA-SECRETA");
	});
});

describe("telemetria do Jev (separada do uso principal)", () => {
	it("agrega duração, modelo e tokens; custo fica desconhecido (null) e sem respostas", () => {
		const collector = createJevTelemetryCollector();
		expect(collector.snapshot()).toBeUndefined();
		collector.record({ feature: "intent", mode: "shadow", source: "jev", durationMs: 120, model: "jev-1", inputTokens: 30, answers: { secret_q: 0.9 } });
		collector.record({ feature: "intent", mode: "shadow", source: "unavailable", durationMs: 2500 });
		collector.record({ feature: "tools", mode: "on", source: "heuristic" });
		const snap = collector.snapshot()!;
		expect(snap).toMatchObject({
			calls: 3,
			totalMs: 2620,
			answered: 1,
			unavailable: 2,
			inputTokens: 30,
			models: ["jev-1"],
			costUsd: null,
		});
		expect(snap.byFeature.intent).toEqual({ calls: 2, totalMs: 2620 });
		expect(JSON.stringify(snap)).not.toContain("secret_q");
	});
});


it("leituras paralelas medem parede do lote e preservam duração individual e overhead", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
	try {
		const steps: RuntimeStepRecord[] = [];
		const autonomy = { level: "autonomous" as const, exceptions: [] };
		const toolset = buildMcpToolset([{
			id: "timing-connector",
			slug: "timing",
			name: "Timing",
			disabledTools: [],
			tools: [{
				name: "read",
				inputSchema: { type: "object", properties: { delay: { type: "number" } } },
				annotations: { readOnlyHint: true },
			}],
		}], { autonomy });
		let turn = 0;
		const run = runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => "unused",
			sandboxEnabled: false,
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "Read the three independent entries." }],
			runId: "run-parallel-timing",
			autonomy,
			mcp: {
				toolset,
				call: async (_name, args) => {
					await new Promise<void>((resolve) => setTimeout(resolve, Number(args.delay)));
					return { ok: true, text: `entry-${args.delay}`, truncated: false };
				},
			},
			onEvent: () => undefined,
			onStep: async (step) => { steps.push(step); },
			onCheckpoint: async () => {
				await new Promise<void>((resolve) => setTimeout(resolve, 20));
			},
			streamChat: async () => ++turn === 1 ? {
				model: "test-model",
				message: {
					role: "assistant",
					content: null,
					tool_calls: [100, 200, 300].map((delay) => ({
						id: `read-${delay}`,
						type: "function" as const,
						function: { name: "mcp__timing__read", arguments: JSON.stringify({ delay }) },
					})),
				},
			} : { model: "test-model", message: { role: "assistant", content: "Done." } },
		});
		await vi.advanceTimersByTimeAsync(1_000);
		await run;
		const tools = steps.filter((step) => step.type === "tool_result");
		expect(tools.map((step) => step.telemetry?.toolMs)).toEqual([100, 200, 300]);
		expect(tools.map((step) => step.durationMs)).toEqual([100, 200, 300]);
		const closing = steps.find((step) => step.type === "checkpoint" && step.subIndex === 99);
		// L9: o lote não grava mais checkpoint por item (eram 20 ms dentro do lote):
		// só a parede das tools (300 ms) está no lote; os checkpoints do início do
		// run e do fim da decisão (20 ms cada) ficam no overhead.
		expect(closing?.telemetry?.toolMsTotal).toBe(300);
		expect(closing?.telemetry?.overheadMs).toBe(40);
		expect(closing?.telemetry?.stepMs).toBe(340);
	} finally {
		vi.useRealTimers();
	}
});
