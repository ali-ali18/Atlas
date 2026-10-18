import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";

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

function step(
	calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
): CompleteChatWithToolsResult {
	return {
		model: "test-model",
		message: {
			role: "assistant",
			content: null,
			tool_calls: calls.map((call) => ({
				id: call.id,
				type: "function" as const,
				function: { name: call.name, arguments: JSON.stringify(call.args) },
			})),
		},
	};
}

function text(content: string): CompleteChatWithToolsResult {
	return { model: "test-model", message: { role: "assistant", content } };
}


describe("cursor do agente no run", () => {
	it("browser_act por ref emite agent_pointer com as coordenadas medidas", async () => {
		const execBrowserAct = vi.fn(async () => ({
			ok: true,
			ref: "e3",
			action: "click" as const,
			pointer: { x: 412, y: 233, screenW: 1280, screenH: 800, name: "Semana 1" },
			newElements: [],
			newTotal: 0,
		}));
		const pointers: Array<Record<string, unknown>> = [];
		const queue = [step([{ id: "a1", name: "browser_act", args: { ref: "e3", action: "click" } }]), text("feito")];
		await runComputerUse({
			manager: { execBrowserAct } as unknown as SandboxManager,
			getSessionId: async () => "session-1",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "clique" }],
			runId: "run-pointer",
			maxSteps: 4,
			onEvent: (event) => {
				if (event.type === "agent_pointer") pointers.push(event);
			},
			streamChat: async () => queue.shift() ?? text("ok"),
		});
		expect(pointers).toHaveLength(1);
		expect(pointers[0]).toMatchObject({ action: "click", x: 412, y: 233, viewportW: 1280, label: "Clicando em “Semana 1”" });
	});
});
