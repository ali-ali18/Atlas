import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { NativeComputerMode } from "@workspace/llm";
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
		persistConversationCardFromEvent: vi.fn(async () => undefined),
	};
});

function text(content: string): CompleteChatWithToolsResult {
	return { model: "m", message: { role: "assistant", content } };
}

function call(name: string, args: Record<string, unknown>): CompleteChatWithToolsResult {
	return {
		model: "m",
		message: {
			role: "assistant",
			content: null,
			tool_calls: [
				{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } },
			],
		},
	};
}

async function offered(model: string, mode: NativeComputerMode | undefined, queue: CompleteChatWithToolsResult[] = []) {
	let tools: string[] = [];
	let system = "";
	const clicks: Array<[number, number]> = [];
	const manager = {
		execScreen: async () => ({ width: 1280, height: 720 }),
		execClick: vi.fn(async (_s: string, x: number, y: number) => {
			clicks.push([x, y]);
			return { url: "https://a.test", navigated: false, settled: true };
		}),
	};
	const results: Array<{ name: string; ok: boolean; summary: string }> = [];
	await runComputerUse({
		manager: manager as unknown as SandboxManager,
		getSessionId: async () => "s",
		model,
		apiKey: "k",
		messages: [{ role: "user", content: "abra a página e faça no desktop" }],
		runId: "run-native",
		maxSteps: 5,
		nativeComputerMode: mode,
		onEvent: (event) => {
			if (event.type === "tool_result") results.push({ name: event.name, ok: event.ok, summary: event.summary });
		},
		streamChat: async (params) => {
			if (tools.length === 0) {
				tools = (params.tools ?? []).map((t) => t.function.name);
				const first = params.messages[0];
				system = typeof first?.content === "string" ? first.content : "";
			}
			return queue.shift() ?? text("ok");
		},
	});
	return { tools, system, clicks, results };
}

describe("F12/C4 - ferramenta de computador nativa", () => {
	it("off (padrão): modelo suportado continua com as tools de coordenada", async () => {
		const { tools } = await offered("anthropic/claude-sonnet-5.5", "off");
		expect(tools).toContain("click");
		expect(tools).toContain("screenshot");
		expect(tools).not.toContain("computer");
	});

	it("shadow: não muda as tools", async () => {
		const { tools } = await offered("anthropic/claude-sonnet-5.5", "shadow");
		expect(tools).toContain("click");
		expect(tools).not.toContain("computer");
	});

	it("on + modelo suportado: `computer` substitui as de coordenada e o prompt avisa", async () => {
		const { tools, system } = await offered("anthropic/claude-sonnet-5.5", "on");
		expect(tools).toContain("computer");
		for (const gone of ["click", "type", "key", "scroll", "screenshot"]) expect(tools).not.toContain(gone);
		expect(tools).toContain("browser_snapshot");
		expect(system).toContain("`computer` tool");
	});

	it("on + modelo sem suporte: nada muda", async () => {
		const { tools } = await offered("openai/gpt-6-luna", "on");
		expect(tools).toContain("click");
		expect(tools).not.toContain("computer");
	});

	it("o executor traduz left_click para a tool de clique e valida args", async () => {
		const ok = await offered("anthropic/claude-sonnet-5.5", "on", [
			call("computer", { action: "left_click", coordinate: [100, 50] }),
			text("feito"),
		]);
		expect(ok.clicks).toHaveLength(1);
		expect(ok.results[0]?.ok).toBe(true);

		const bad = await offered("anthropic/claude-sonnet-5.5", "on", [
			call("computer", { action: "left_click" }),
			text("feito"),
		]);
		expect(bad.clicks).toHaveLength(0);
		expect(bad.results[0]?.ok).toBe(false);
		expect(bad.results[0]?.summary).toMatch(/coordinate/);
	});
});
