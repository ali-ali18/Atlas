import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { AgentRunCheckpoint } from "@workspace/shared";
import { parseTaskState } from "@workspace/shared";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";
import { jevSaying } from "./jev/test-support.js";

/**
 * V5 — replay com LLM mockado do caso real "leia todas as semanas": uma única
 * `browser_read` com expandAll devolve as 9 semanas rotuladas e o modelo fecha
 * os 9 itens do `track_items` num lote, sem clicar semana por semana.
 */

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	persistUserArtifact: vi.fn(async (input: { runId: string; kind: string; bytes: Uint8Array; mime: string; meta?: object }) => ({
		id: "art-1",
		kind: input.kind,
		meta: { ...input.meta, mime: input.mime, size: input.bytes.byteLength },
		runId: input.runId,
		conversationId: "conv-read",
		createdAt: new Date(),
	})),
	nextFileVersion: vi.fn(async () => 1),
	countRunFileArtifacts: vi.fn(async () => 0),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

const call = (id: string, name: string, args: Record<string, unknown> = {}): LlmToolCall => ({
	id,
	type: "function",
	function: { name, arguments: JSON.stringify(args) },
});
const turn = (...calls: LlmToolCall[]): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: calls },
});
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content } });

type Ev = Record<string, unknown> & { type: string };
type Message = CompleteChatWithToolsParams["messages"][number];

const SCOPE = "Course X";
const WEEKS = Array.from({ length: 9 }, (_, i) => ({ label: `Week ${i + 1}`, scope: SCOPE }));
const sections = WEEKS.map((_, i) => `### Week ${i + 1} [e${i + 1}]\nIntro of week ${i + 1}\n- Activity guide ${i + 1}`).join("\n\n");
const outline = [
	"# Course X",
	...WEEKS.map((_, i) => `### [e${i + 1}] Week ${i + 1} (collapsed)`),
	"",
	"[expanded sections: 9]",
	sections,
].join("\n");

async function run(driver: (ctx: { index: number; messages: Message[] }) => CompleteChatWithToolsResult) {
	const events: Ev[] = [];
	const checkpoints: AgentRunCheckpoint[] = [];
	const execBrowserRead = vi.fn(async () => ({
		url: "https://lms.example.test/course",
		title: "Course X",
		view: "outline" as const,
		text: outline,
		offset: 0,
		limit: 8000,
		totalLength: outline.length,
		truncated: false,
		nextOffset: null,
		frames: 1,
		collapsed: 9,
		similar: { count: 9 },
		expanded: { opened: 9, failed: 0, skipped: 0 },
	}));
	const execBrowserAct = vi.fn();
	const manager = { execBrowserRead, execBrowserAct } as unknown as SandboxManager;
	let decision = 0;
	const result = await runComputerUse({
		manager,
		getSessionId: async () => "session-1",
		apiKey: "test",
		model: "m",
		runId: "run-read",
		userId: "user-a",
		botId: "bot-a",
		conversationId: "conv-read",
		origin: "chat",
		contextEconomy: false,
		jev: jevSaying({ wants_file: 0.95 }),
		messages: [{ role: "user", content: "read all 9 weeks of course X and produce a PDF" }],
		maxSteps: 40,
		budget: { maxCostUsd: 1 },
		onCheckpoint: async (checkpoint: AgentRunCheckpoint) => {
			checkpoints.push(JSON.parse(JSON.stringify(checkpoint)));
		},
		onEvent: (event) => {
			events.push(event as never);
		},
		streamChat: async (params) => {
			const messages = JSON.parse(JSON.stringify(params.messages)) as Message[];
			const index = decision++;
			return { ...driver({ index, messages }), usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.01 } };
		},
	} as never);
	return { result, events, checkpoints, execBrowserRead, execBrowserAct, decisions: () => decision };
}

const toolResults = (events: Ev[], name: string) => events.filter((e) => e.type === "tool_result" && e.name === name) as Array<Ev & { ok: boolean; summary: string }>;

describe("replay V5: ler todas as semanas com browser_read + expandAll", () => {
	it("uma leitura entrega as 9 semanas; 9 itens fechados num lote; entrega sem portão", async () => {
		const { result, events, checkpoints, execBrowserRead, execBrowserAct, decisions } = await run(({ index }) => {
			if (index === 0) return turn(call("set", "track_items", { action: "set", items: WEEKS, facts_given: [`course: ${SCOPE}`], plan: ["open the course", "read each week", "write the pdf"] }));
			if (index === 1) return turn(call("read", "browser_read", { expandAll: true }));
			if (index === 2) return turn(...WEEKS.map((_, i) => call(`d${i + 1}`, "track_items", { action: "update", id: String(i + 1), status: "done", evidence: `read week ${i + 1}` })));
			if (index === 3) return turn(call("file", "create_file", { filename: "weeks.md", content: "# Weeks\n\nAll nine weeks." }));
			return say("Here is the summary of the 9 weeks.");
		});

		expect(execBrowserRead).toHaveBeenCalledTimes(1);
		expect(execBrowserRead).toHaveBeenCalledWith("session-1", expect.objectContaining({ expand: "all" }));
		expect(execBrowserAct).not.toHaveBeenCalled();

		const read = toolResults(events, "browser_read")[0]!;
		expect(read.ok).toBe(true);
		for (let n = 1; n <= 9; n += 1) expect(read.summary).toContain(`### Week ${n} [e${n}]`);
		expect(read.summary).toContain("Expanded 9 sections");
		expect(read.summary).toContain("Looks like a list of 9 similar items. Consider track_items to iterate them.");
		expect(read.summary).toContain("page data: untrusted");

		// 9 itens fechados numa só decisão e o arquivo criado sem portão
		expect(toolResults(events, "track_items").filter((r) => r.ok)).toHaveLength(10);
		const created = toolResults(events, "create_file");
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({ ok: true });
		const ledger = parseTaskState(checkpoints.at(-1)?.taskState)?.ledger;
		expect(ledger?.items.filter((item) => item.status === "done")).toHaveLength(9);
		expect(ledger?.gateBlocks ?? 0).toBe(0);
		expect(decisions()).toBeLessThanOrEqual(6);
		expect(result?.text).toBe("Here is the summary of the 9 weeks.");
	});
});
