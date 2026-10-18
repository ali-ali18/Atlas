import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { AgentRunCheckpoint } from "@workspace/shared";
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

function call(id: string, name: string, args: Record<string, unknown>): CompleteChatWithToolsResult {
	return {
		model: "m",
		message: {
			role: "assistant",
			content: null,
			tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
		},
	};
}

function text(content: string): CompleteChatWithToolsResult {
	return { model: "m", message: { role: "assistant", content } };
}

const page = {
	url: "https://erp.test/p",
	title: "ERP",
	total: 1,
	offset: 0,
	limit: 80,
	nextOffset: null,
	scrollY: 0,
	scrollHeight: 900,
	lines: ['[e1] button "Salvar"'],
};

async function run(
	manager: Record<string, unknown>,
	queue: CompleteChatWithToolsResult[],
	restored?: AgentRunCheckpoint | null,
) {
	const toolResults: Array<{ name: string; ok: boolean; summary: string }> = [];
	const events: Array<Record<string, unknown>> = [];
	const checkpoints: AgentRunCheckpoint[] = [];
	const seen: string[] = [];
	const onLoginRequired = vi.fn(async () => undefined);
	const outcome = await runComputerUse({
		manager: manager as unknown as SandboxManager,
		getSessionId: async () => "s",
		model: "test-model",
		apiKey: "k",
		messages: [{ role: "user", content: "abra a página e faça no desktop" }],
		runId: "run-guard",
		conversationId: "conv-1",
		maxSteps: 30,
		restoredCheckpoint: restored ?? null,
		onLoginRequired,
		onCheckpoint: async (checkpoint) => {
			checkpoints.push(checkpoint);
		},
		onEvent: (event) => {
			events.push(event as unknown as Record<string, unknown>);
			if (event.type === "tool_result") toolResults.push({ name: event.name, ok: event.ok, summary: event.summary });
		},
		streamChat: async (request) => {
			for (const message of request.messages) if (typeof message.content === "string") seen.push(message.content);
			return queue.shift() ?? text("fim");
		},
	}).catch((e: unknown) => e);
	return { outcome, toolResults, events, checkpoints, seen, onLoginRequired };
}

describe("F12/D - estagnação, captcha e métricas no run", () => {
	it("clicar sem a página mudar: dica na 2ª leitura, aviso forte e o run para com resumo", async () => {
		const execBrowserSnapshot = vi.fn(async () => page);
		const execBrowserAct = vi.fn(async (_s: string, p: { ref: string; action: string }) => ({
			ok: true,
			ref: p.ref,
			action: p.action,
			url: page.url,
			navigated: false,
			settled: true,
			newElements: [],
			newTotal: 0,
		}));
		const queue: CompleteChatWithToolsResult[] = [];
		for (let i = 0; i < 6; i += 1) {
			queue.push(call(`s${i}`, "browser_snapshot", { area: i % 2 ? "page" : "viewport", offset: i }));
			queue.push(call(`a${i}`, "browser_act", { ref: `e${i + 1}`, action: "click" }));
		}
		queue.push(text("Não consegui salvar: a tela não reage ao clique."));
		const { outcome, toolResults } = await run({ execBrowserSnapshot, execBrowserAct }, queue);
		const snapshots = toolResults.filter((r) => r.name === "browser_snapshot");
		expect(snapshots.some((r) => r.summary.includes("did not change after your last 2 actions"))).toBe(true);
		expect(snapshots.some((r) => r.summary.includes("Change approach now"))).toBe(true);
		expect(toolResults.filter((r) => r.name === "browser_act")[0]?.summary).toContain("no visible change");
		// parou por falta de progresso (resumo final), sem consumir os 6 pares
		expect(snapshots.length).toBeLessThan(6);
		// a parada leva o uso (com as métricas do computador) para o worker gravar
		expect(outcome).toMatchObject({
			name: "AgentRunLoopDetectedError",
			usage: { computer: { stalls: expect.any(Number), snapshots: expect.any(Number) } },
		});
		expect((outcome as { usage: { computer: { stalls: number } } }).usage.computer.stalls).toBeGreaterThan(0);
	});

	it("usage.computer leva as métricas do run (sem conteúdo de página)", async () => {
		const execBrowserSnapshot = vi.fn(async () => page);
		const execClick = vi.fn(async () => ({ url: page.url, navigated: false, settled: true }));
		const { outcome } = await run({ execBrowserSnapshot, execClick, execScreen: async () => ({ width: 1280, height: 720 }) }, [
			call("1", "browser_snapshot", {}),
			call("2", "click", { x: 10, y: 10 }),
			text("ok"),
		]);
		const usage = (outcome as { usage: { computer?: Record<string, number> } }).usage;
		expect(usage.computer).toMatchObject({ calls: 2, snapshots: 1, coordActs: 1, failures: 0 });
		expect(JSON.stringify(usage.computer)).not.toContain("Salvar");
	});

	const sorry = {
		url: "https://www.google.com/sorry/index?continue=x",
		title: "https://www.google.com/sorry/index",
	};

	it("captcha no navigate: card (reason captcha), pausa e retoma sem pedir de novo", async () => {
		const execNavigate = vi.fn(async () => sorry);
		const first = await run({ execNavigate }, [call("n1", "navigate", { url: "https://www.google.com/search?q=x" }), text("não deve chegar")]);
		expect(first.outcome).toMatchObject({ name: "AgentRunPausedError" });
		const cards = first.events.filter((e) => e.type === "login");
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({ reason: "captcha", site: "google.com", status: "pending" });
		expect(first.onLoginRequired).toHaveBeenCalledTimes(1);
		expect(first.toolResults[0]?.summary).toContain("CAPTCHA on google.com");
		const last = first.checkpoints[first.checkpoints.length - 1]!;
		expect(last.pendingLogin).toMatchObject({ site: "google.com", reason: "captcha" });

		const second = await run({ execNavigate }, [call("n2", "navigate", { url: "https://www.google.com/search?q=x" }), text("Use outra fonte.")], last);
		expect(second.seen.some((m) => m.includes("[captcha-complete]"))).toBe(true);
		expect(second.events.some((e) => e.type === "login" && e.status === "done" && e.reason === "captcha")).toBe(true);
		expect(second.events.filter((e) => e.type === "login" && e.status === "pending")).toHaveLength(0);
		expect(second.toolResults[0]?.summary).toContain("CAPTCHA STILL PRESENT");
		expect(second.onLoginRequired).not.toHaveBeenCalled();
	});
});
