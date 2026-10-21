import { describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { StepInspect } from "@workspace/shared";
import { runComputerUse } from "./computer-use.js";

vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

async function inspectOfFirstStep(priorCompaction?: { before: number; after: number }) {
	const inspects: StepInspect[] = [];
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		sandboxEnabled: false,
		apiKey: "test",
		model: "m",
		runId: "run-compact",
		userId: "user-a",
		origin: "chat",
		messages: [{ role: "user", content: "oi" }],
		priorCompaction,
		onEvent: () => undefined,
		onStep: async (step) => {
			const inspect = (step.outputJson as { inspect?: StepInspect } | undefined)?.inspect;
			if (step.type === "model" && inspect) inspects.push(inspect);
		},
		streamChat: async () => ({ model: "m", message: { role: "assistant", content: "ok" }, finishReason: "stop" }),
	});
	return inspects;
}

describe("inspetor: ação da conversa compactada", () => {
	it("o 1º passo depois do /compact mostra a ação com antes e depois, e só ele", async () => {
		const [first] = await inspectOfFirstStep({ before: 48_200, after: 6_100 });
		expect(first?.actions).toContainEqual({ kind: "compact", before: 48_200, after: 6_100 });
	});

	it("sem compactação nenhuma ação aparece", async () => {
		const [first] = await inspectOfFirstStep();
		expect(first?.actions.some((action) => action.kind === "compact")).toBe(false);
	});
});
