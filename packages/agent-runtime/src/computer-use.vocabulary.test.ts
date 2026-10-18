import { describe, expect, it, vi } from "vitest";
import type { ChatTool, CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

// V6 — replays com o vocabulário novo e com os nomes antigos (checkpoints, skills salvas).

type Call = { id: string; name: string; args: Record<string, unknown> };
const step = (...calls: Call[]): CompleteChatWithToolsResult => ({
	model: "m",
	message: {
		role: "assistant",
		content: null,
		tool_calls: calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.args) } })),
	},
});
const done: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "Pronto." } };

const clickResult = {
	ok: true,
	target: "Week 1",
	settled: true,
	waitMs: 100,
	url: "https://lms.test/c",
	navigated: false,
	changes: { added: "Unit 01" },
	newTotal: 0,
};
const manager = () =>
	({
		execNavigate: vi.fn(async () => ({ url: "https://lms.test/c", title: "Curso", ready: true })),
		execBrowserRead: vi.fn(async () => ({
			url: "https://lms.test/c",
			title: "Curso",
			text: "# Curso\n[e1] button Week 1",
			totalLength: 24,
			offset: 0,
			view: "outline",
			frames: 1,
			collapsed: 0,
			truncated: false,
			nextOffset: null,
		})),
		execBrowserClick: vi.fn(async () => clickResult),
		execBrowserType: vi.fn(async () => ({ ok: true, settled: true, waitMs: 50, url: "https://lms.test/c", navigated: false })),
		execBrowserText: vi.fn(async () => ({ url: "https://lms.test/c", title: "Curso", text: "texto", totalLength: 5 })),
		execBrowserLinks: vi.fn(async () => ({ links: [{ text: "Home", href: "https://lms.test/" }] })),
		execScroll: vi.fn(async () => ({ scrollY: 600, scrollHeight: 3000 })),
	}) as unknown as SandboxManager & Record<string, ReturnType<typeof vi.fn>>;

async function run(input: { script: CompleteChatWithToolsResult[]; sandboxEnabled?: boolean; manager?: SandboxManager }) {
	const offered: string[][] = [];
	const results: Array<{ name: string; ok: boolean; summary: string }> = [];
	const script = [...input.script];
	await runComputerUse({
		manager: input.manager ?? manager(),
		getSessionId: async () => "s1",
		sandboxEnabled: input.sandboxEnabled ?? true,
		apiKey: "test",
		model: "m",
		runId: "run-vocab",
		userId: "user-a",
		botId: "bot-a",
		origin: "chat",
		contextEconomy: true,
		messages: [{ role: "user", content: "veja as semanas do curso" }],
		maxSteps: 12,
		onEvent: (event) => {
			if (event.type === "tool_result") results.push({ name: event.name, ok: event.ok, summary: event.summary });
		},
		streamChat: async (params) => {
			offered.push((params.tools ?? []).map((tool: ChatTool) => tool.function.name));
			return script.shift() ?? done;
		},
	});
	return { offered, results };
}

const isBrowserTool = (name: string) => name === "navigate" || name === "screenshot" || name.startsWith("browser_");

describe("V6 - replay com o vocabulário novo", () => {
	it("abrir, ler, clicar por texto, digitar e rolar com só as tools novas (<= 8 de navegador no 1º passo)", async () => {
		const sandbox = manager();
		const { offered, results } = await run({
			manager: sandbox,
			script: [
				step({ id: "a", name: "navigate", args: { url: "https://lms.test/c" } }),
				step({ id: "b", name: "browser_read", args: { expandAll: true } }),
				step(
					{ id: "c", name: "browser_act", args: { action: "click", text: "Week 1" } },
					{ id: "d", name: "browser_act", args: { action: "type", selector: "#q", value: "unit", submit: true } },
					{ id: "e", name: "browser_act", args: { action: "scroll", value: "down" } },
				),
				done,
			],
		});
		const browserOffered = offered[0]!.filter(isBrowserTool);
		expect(browserOffered.length).toBeLessThanOrEqual(8);
		expect(browserOffered).toEqual(expect.arrayContaining(["navigate", "browser_read", "browser_find", "browser_snapshot", "browser_act", "browser_wait", "screenshot"]));
		for (const old of ["browser_click", "browser_type", "browser_text", "browser_links"]) expect(offered[0]).not.toContain(old);
		// Decisão 0 já pode chamar as tools: nenhuma volta por `mcp_tool_search` nem "not loaded".
		expect(results.map((r) => r.name)).toEqual(["navigate", "browser_read", "browser_act", "browser_act", "browser_act"]);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(results.some((r) => /not loaded/i.test(r.summary))).toBe(false);
		expect(sandbox.execBrowserClick).toHaveBeenCalledWith("s1", { selector: undefined, text: "Week 1" });
		expect(sandbox.execBrowserType).toHaveBeenCalledWith("s1", { selector: "#q", text: "unit", submit: true });
		expect(sandbox.execScroll).toHaveBeenCalledWith("s1", 0, 600);
		expect(results[2]!.summary).toContain("Clicked Week 1");
	});
});

describe("V6 - aliases dos nomes antigos", () => {
	it("browser_text, browser_links, browser_click e browser_type ainda executam, sem aparecer na lista oferecida", async () => {
		const sandbox = manager();
		const { offered, results } = await run({
			manager: sandbox,
			script: [
				step({ id: "t", name: "browser_text", args: {} }),
				step({ id: "l", name: "browser_links", args: {} }),
				step({ id: "c", name: "browser_click", args: { text: "Week 1" } }),
				step({ id: "y", name: "browser_type", args: { selector: "#q", text: "unit" } }),
				done,
			],
		});
		expect(results.map((r) => [r.name, r.ok])).toEqual([
			["browser_text", true],
			["browser_links", true],
			["browser_click", true],
			["browser_type", true],
		]);
		expect(results[1]!.summary).toContain("Home");
		expect(results[2]!.summary).toContain("Clicked Week 1");
		expect(results[3]!.summary).toContain("Filled #q");
		for (const list of offered) for (const old of ["browser_click", "browser_type", "browser_text", "browser_links"]) expect(list).not.toContain(old);
		expect(sandbox.execBrowserText).toHaveBeenCalledTimes(1);
	});

	it("sem sandbox os nomes antigos continuam recusados (alias só vale com a tool nova disponível)", async () => {
		const { results } = await run({
			sandboxEnabled: false,
			script: [step({ id: "c", name: "browser_click", args: { text: "Week 1" } }), done],
		});
		expect(results[0]).toMatchObject({ name: "browser_click", ok: false });
		expect(results[0]!.summary).toMatch(/not available in this run/);
	});
});
