import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";
import { BATCH_SKIPPED_MESSAGE, createBatchFailureGate } from "./tools/batch-failure.js";

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		searchMemoryEntries: async () => [],
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		listRoutines: vi.fn(async () => []),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
	};
});

const step = (calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): CompleteChatWithToolsResult => ({
	model: "test-model",
	message: {
		role: "assistant",
		content: null,
		tool_calls: calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.args) } })),
	},
});
const text = (content: string): CompleteChatWithToolsResult => ({ model: "test-model", message: { role: "assistant", content } });

const snapshot = { url: "https://lms.test/", title: "t", total: 0, offset: 0, limit: 80, nextOffset: null, lines: [] };

async function runWith(manager: Record<string, unknown>, steps: CompleteChatWithToolsResult[]) {
	// O primeiro passo (snapshot) carrega o grupo de ferramentas do navegador.
	const queue = [step([{ id: "prime", name: "browser_snapshot", args: {} }]), ...steps];
	manager = { execBrowserSnapshot: vi.fn(async () => snapshot), ...manager };
	const toolResults: Array<{ id: string; name: string; ok: boolean; summary: string }> = [];
	await runComputerUse({
		manager: manager as unknown as SandboxManager,
		getSessionId: async () => "session-1",
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: "open the three sections" }],
		runId: "run-batch",
		maxSteps: 20,
		onEvent: (event) => {
			if (event.type === "tool_result") toolResults.push({ id: event.id, name: event.name, ok: event.ok, summary: event.summary });
		},
		streamChat: async () => queue.shift() ?? text("ok"),
	});
	return { toolResults };
}

const acted = (p: { ref: string; action: string }) => ({
	ok: true, ref: p.ref, action: p.action, url: "https://lms.test/", navigated: false, settled: true, newElements: [], newTotal: 0,
});

describe("lote de chamadas: para depois da primeira ação de página que falhou", () => {
	it("gate puro: só ação de página falha e fecha o lote; leitura não", () => {
		const gate = createBatchFailureGate();
		gate.recordResult("browser_read", false);
		expect(gate.shouldSkip("browser_act")).toBe(false);
		gate.recordResult("browser_act", true);
		expect(gate.shouldSkip("browser_act")).toBe(false);
		gate.recordResult("browser_click", false);
		expect(gate.shouldSkip("browser_act")).toBe(true);
		expect(gate.shouldSkip("navigate")).toBe(true);
		expect(gate.shouldSkip("browser_read")).toBe(false);
		expect(gate.shouldSkip("web_search")).toBe(false);
	});

	it("3 cliques no mesmo passo: o 1º falha, o 2º e o 3º não executam", async () => {
		const execBrowserAct = vi.fn(async (_s: string, p: { ref: string; action: string }) => {
			if (p.ref === "e1") throw new Error("Element e1 is covered by a dialog");
			return acted(p);
		});
		const { toolResults } = await runWith({ execBrowserAct }, [
			step([
				{ id: "a", name: "browser_act", args: { ref: "e1", action: "click" } },
				{ id: "b", name: "browser_act", args: { ref: "e2", action: "click" } },
				{ id: "c", name: "browser_act", args: { ref: "e3", action: "click" } },
			]),
			text("done"),
		]);
		expect(execBrowserAct).toHaveBeenCalledTimes(1);
		expect(toolResults.slice(1).map((r) => r.ok)).toEqual([false, false, false]);
		expect(toolResults[1]!.summary).toContain("covered by a dialog");
		expect(toolResults[2]!.summary).toBe(BATCH_SKIPPED_MESSAGE);
		expect(toolResults[3]!.summary).toBe(BATCH_SKIPPED_MESSAGE);
	});

	it("sem falha, o lote inteiro roda; uma leitura depois da falha também roda", async () => {
		const execBrowserAct = vi.fn(async (_s: string, p: { ref: string; action: string }) => acted(p));
		const ok = await runWith({ execBrowserAct }, [
			step([
				{ id: "a", name: "browser_act", args: { ref: "e1", action: "click" } },
				{ id: "b", name: "browser_act", args: { ref: "e2", action: "click" } },
			]),
			text("done"),
		]);
		expect(execBrowserAct).toHaveBeenCalledTimes(2);
		expect(ok.toolResults.slice(1).every((r) => r.ok)).toBe(true);
		expect(ok.toolResults).toHaveLength(3);

		const execBrowserRead = vi.fn(async () => ({
			url: "https://lms.test/", title: "t", view: "outline" as const, text: "x", offset: 0, limit: 8000, totalLength: 1,
			truncated: false, nextOffset: null, frames: 1, collapsed: 0,
		}));
		const failing = vi.fn(async () => {
			throw new Error("boom");
		});
		const mixed = await runWith({ execBrowserAct: failing, execBrowserRead }, [
			step([
				{ id: "a", name: "browser_act", args: { ref: "e1", action: "click" } },
				{ id: "r", name: "browser_read", args: {} },
				{ id: "b", name: "browser_act", args: { ref: "e2", action: "click" } },
			]),
			text("done"),
		]);
		expect(failing).toHaveBeenCalledTimes(1);
		expect(execBrowserRead).toHaveBeenCalledTimes(1);
		expect(mixed.toolResults.slice(1).map((r) => [r.name, r.ok])).toEqual([["browser_act", false], ["browser_read", true], ["browser_act", false]]);
		expect(mixed.toolResults[3]!.summary).toBe(BATCH_SKIPPED_MESSAGE);
	});
});
