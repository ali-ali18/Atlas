import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { COMPUTER_USE_TOOLS, SYSTEM_PROMPT, runComputerUse } from "./computer-use.js";
import { MAX_ADDED_CHARS } from "./tools/computer-changes.js";

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

type Call = { id: string; name: string; args: Record<string, unknown> };

function step(calls: Call[]): CompleteChatWithToolsResult {
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

async function run(manager: Record<string, unknown>, queue: CompleteChatWithToolsResult[]) {
	const results: Array<{ id: string; name: string; ok: boolean; summary: string }> = [];
	await runComputerUse({
		manager: manager as unknown as SandboxManager,
		getSessionId: async () => "session-1",
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: "abra as semanas e liste os títulos" }],
		runId: "run-diff",
		maxSteps: 10,
		onEvent: (event) => {
			if (event.type === "tool_result") {
				results.push({ id: event.toolCallId ?? "", name: event.name, ok: event.ok, summary: event.summary });
			}
		},
		streamChat: async () => queue.shift() ?? { model: "test-model", message: { role: "assistant", content: "ok" } },
	});
	return results;
}

const week = (n: number) => `Unit ${String(n).padStart(2, "0")} ${"Reading and activities ".repeat(60)}`;

describe("V4 - lote de cliques mantém o diff de cada ação (replay das 9 semanas)", () => {
	it("9 browser_act no mesmo turno: cada resultado traz os títulos revelados, com teto", async () => {
		const execBrowserAct = vi.fn(async (_s: string, p: { ref: string; action: string }) => {
			const n = Number(p.ref.slice(1));
			return {
				ok: true,
				ref: p.ref,
				action: p.action,
				url: "https://lms.test/course",
				navigated: false,
				settled: true,
				waitMs: 190,
				changes: {
					added: week(n).slice(0, MAX_ADDED_CHARS),
					addedTotalChars: week(n).length,
					states: [`${p.ref} "Week ${n}" expanded false→true`],
				},
				newElements: [`[e${n + 100}] link "Unit ${n} Intro"`],
				newTotal: 1,
			};
		});
		const calls = Array.from({ length: 9 }, (_, i) => ({
			id: `w${i + 1}`,
			name: "browser_act",
			args: { ref: `e${i + 1}`, action: "click" },
		}));
		const results = await run({ execBrowserAct }, [step(calls)]);
		expect(results).toHaveLength(9);
		results.forEach((result, i) => {
			const n = i + 1;
			expect(result.ok).toBe(true);
			expect(result.summary).toContain(`Unit ${String(n).padStart(2, "0")} Reading`);
			expect(result.summary).toContain(`"Week ${n}" expanded false→true`);
			expect(result.summary).toContain(`[e${n + 100}] link "Unit ${n} Intro"`);
			expect(result.summary).toContain("more chars: use browser_read");
			expect(result.summary.length).toBeLessThan(MAX_ADDED_CHARS + 700);
		});
		const total = results.reduce((sum, r) => sum + r.summary.length, 0);
		expect(total).toBeLessThan(9 * (MAX_ADDED_CHARS + 700));
	});

	it("browser_click por texto e browser_type devolvem o mesmo relatório", async () => {
		const execBrowserClick = vi.fn(async () => ({
			ok: true,
			target: "Week 2",
			settled: true,
			waitMs: 300,
			url: "https://lms.test/course",
			navigated: false,
			changes: { added: "Unit 02 Intro | Activity guide" },
			newElements: ['[e9] link "Unit 02 Intro"'],
			newTotal: 1,
		}));
		const execBrowserType = vi.fn(async () => ({
			ok: true,
			settled: true,
			waitMs: 210,
			url: "https://lms.test/search",
			navigated: false,
			changes: { added: "3 results" },
		}));
		const results = await run({ execBrowserClick, execBrowserType }, [
			step([{ id: "c", name: "browser_click", args: { text: "Week 2" } }]),
			step([{ id: "t", name: "browser_type", args: { selector: "#q", text: "unit", submit: true } }]),
		]);
		expect(results[0]?.summary).toContain("Clicked Week 2 [300 ms]");
		expect(results[0]?.summary).toContain('Added content (30 chars): "Unit 02 Intro | Activity guide"');
		expect(results[0]?.summary).toContain('[e9] link "Unit 02 Intro"');
		expect(results[1]?.summary).toContain("Filled #q + Enter [210 ms]");
		expect(results[1]?.summary).toContain('Added content (9 chars): "3 results"');
	});

	it("descrições e prompt mandam confiar no relatório de mudanças em vez de re-snapshot", () => {
		const byName = (name: string) => COMPUTER_USE_TOOLS.find((t) => t.function.name === name)!.function.description ?? "";
		expect(byName("browser_act")).toContain("report what changed");
		expect(byName("browser_snapshot")).toContain("browser_act already reports what changed");
		expect(COMPUTER_USE_TOOLS.some((t) => t.function.name === "browser_click")).toBe(false);
		expect(SYSTEM_PROMPT).toContain("do not re-read or re-snapshot after each action");
	});
});
