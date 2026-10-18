import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse, type RuntimeStepRecord } from "./computer-use.js";
import { navigateTimingTelemetry, toolStepTelemetry } from "./telemetry/step-telemetry.js";

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		searchMemoryEntries: async () => [],
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		listRoutines: vi.fn(async () => []),
	};
});

describe("V0 - telemetria de tempo do navigate", () => {
	it("navigateTimingTelemetry copia só os números conhecidos do resultado do control server", () => {
		expect(
			navigateTimingTelemetry({
				gotoMs: 812.4,
				readyMs: 4100,
				textLength: 0,
				url: "https://x.test/?token=segredo",
				text: "conteudo da pagina",
				hint: "page is still rendering",
			}),
		).toEqual({ gotoMs: 812, readyMs: 4100, textLen: 0 });
		expect(navigateTimingTelemetry({ gotoMs: "1", readyMs: -5, textLength: Number.NaN })).toBeUndefined();
		expect(navigateTimingTelemetry(undefined)).toBeUndefined();
	});

	it("toolStepTelemetry inclui nav só quando existe", () => {
		expect(toolStepTelemetry("navigate", 1200.6)).toEqual({ v: 1, toolName: "navigate", toolMs: 1201 });
		expect(toolStepTelemetry("navigate", 10, { nav: { gotoMs: 5 } }).nav).toEqual({ gotoMs: 5 });
	});

	it("o passo da tool navigate grava a quebra de tempo e não vaza o conteúdo", async () => {
		const steps: RuntimeStepRecord[] = [];
		const queue: CompleteChatWithToolsResult[] = [
			{
				model: "test-model",
				message: {
					role: "assistant",
					content: null,
					tool_calls: [
						{ id: "n1", type: "function", function: { name: "navigate", arguments: JSON.stringify({ url: "https://x.test/" }) } },
					],
				},
			},
			{ model: "test-model", message: { role: "assistant", content: "pronto" } },
		];
		const manager = {
			execNavigate: async () => ({
				url: "https://x.test/",
				title: "X",
				ready: true,
				gotoMs: 300,
				readyMs: 4200,
				textLength: 0,
				leaked: "SEGREDO",
			}),
		} as unknown as SandboxManager;
		await runComputerUse({
			manager,
			getSessionId: async () => "session-1",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "abra" }],
			runId: "run-nav-timing",
			maxSteps: 4,
			onEvent: () => undefined,
			streamChat: async () => queue.shift() ?? { model: "test-model", message: { role: "assistant", content: "ok" } },
			onStep: async (step) => {
				steps.push(step);
			},
		});
		const toolStep = steps.find((step) => step.type === "tool_result" && step.telemetry?.toolName === "navigate");
		expect(toolStep?.telemetry?.nav).toEqual({ gotoMs: 300, readyMs: 4200, textLen: 0 });
		expect(JSON.stringify(steps)).not.toContain("SEGREDO");
	});
});
