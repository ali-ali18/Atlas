import { expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsResult, LlmMessage, LlmToolCall } from "@workspace/llm";
import { runComputerUse, unavailableToolMessage } from "./computer-use.js";
import { resolveLlmMessagesForModel } from "./checkpoint.js";
import { buildMcpToolset } from "./mcp/registry.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

const autonomy = { level: "autonomous" as const, exceptions: [] };
const connection = {
	id: "conn-a",
	slug: "data",
	name: "Data",
	disabledTools: [],
	tools: [
		{ name: "search", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } },
		{ name: "lookup", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
	],
};
// maxTools: 1 deixa o conjunto deferred: a tool só existe depois de carregada.
const toolset = buildMcpToolset([connection], { autonomy, maxTools: 1 });
const call = (id: string, name: string, args: Record<string, unknown>): LlmToolCall => ({
	id,
	type: "function",
	function: { name, arguments: JSON.stringify(args) },
});
const done: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "Finished." } };
const base = {
	manager: {} as SandboxManager,
	getSessionId: async () => "unused",
	sandboxEnabled: false,
	apiKey: "test",
	model: "m",
	runId: "run-c",
	userId: "user-a",
	origin: "chat",
	autonomy,
	messages: [{ role: "user" as const, content: "Look it up." }],
};

async function callAndCollect(name: string, extra: Record<string, unknown> = {}) {
	const connector = vi.fn(async () => ({ ok: true, text: "data", truncated: false }));
	const requests: LlmMessage[][] = [];
	let decision = 0;
	await runComputerUse({
		...base,
		mcp: { toolset, call: connector },
		onEvent: () => undefined,
		streamChat: async (params) => {
			requests.push(JSON.parse(JSON.stringify(params.messages)) as LlmMessage[]);
			return decision++ === 0
				? { model: "m", message: { role: "assistant", content: null, tool_calls: [call("t1", name, {})] } }
				: done;
		},
		...extra,
	});
	const toolText = requests[1]?.find((message) => message.role === "tool")?.content;
	return { connector, toolText: String(toolText) };
}

it("L19: a connector tool that was never loaded is rejected without calling the executor", async () => {
	const { connector, toolText } = await callAndCollect("mcp__data__lookup");
	expect(connector).not.toHaveBeenCalled();
	expect(toolText).toBe(unavailableToolMessage("mcp__data__lookup", true, true));
	expect(toolText).toContain("mcp_tool_search");
});

it("L19: a tool removed by the effective filter is rejected without running", async () => {
	const { connector, toolText } = await callAndCollect("create_file", {
		toolFilter: (name: string) => name !== "create_file",
	});
	expect(connector).not.toHaveBeenCalled();
	expect(toolText).toContain("not available in this run");
});

it("L19: a made-up tool name is rejected with a clear error", async () => {
	const { toolText } = await callAndCollect("does_not_exist");
	expect(toolText).toContain("does_not_exist is not available in this run");
});

it("L19: screenshot_ref without vision becomes a text alternative, with vision it expands", async () => {
	const messages: LlmMessage[] = [
		{ role: "user", content: [{ type: "text", text: "Current screen:" }, { type: "screenshot_ref", artifactId: "shot1" }] },
	];
	const loader = vi.fn(async () => "data:image/png;base64,AAAA");
	const blind = await resolveLlmMessagesForModel(messages, loader, { canSeeScreenshots: false });
	const parts = blind[0]!.content as Array<{ type: string; text?: string }>;
	expect(parts.map((part) => part.type)).toEqual(["text", "text"]);
	expect(parts[1]!.text).toContain("cannot see images");
	expect(loader).not.toHaveBeenCalled();

	const sighted = await resolveLlmMessagesForModel(messages, loader, { canSeeScreenshots: true });
	expect((sighted[0]!.content as Array<{ type: string }>)[1]!.type).toBe("image_url");
	// Sem a informação (chamadores antigos) o comportamento anterior se mantém.
	const legacy = await resolveLlmMessagesForModel(messages, loader);
	expect((legacy[0]!.content as Array<{ type: string }>)[1]!.type).toBe("image_url");
});

it("L19: a blind model never receives image parts from stored screenshots", async () => {
	const requests: LlmMessage[][] = [];
	const loader = vi.fn(async () => "data:image/png;base64,AAAA");
	await runComputerUse({
		...base,
		canSeeUserImages: false,
		loadScreenshot: loader,
		restoredCheckpoint: {
			version: 2,
			nextStepIndex: 1,
			messages: [],
			llmMessages: [
				{ role: "user", content: "Look it up." },
				{ role: "user", content: [{ type: "text", text: "Current screen:" }, { type: "screenshot_ref", artifactId: "shot1" }] },
			],
		},
		onEvent: () => undefined,
		streamChat: async (params) => {
			requests.push(JSON.parse(JSON.stringify(params.messages)) as LlmMessage[]);
			return done;
		},
	});
	expect(loader).not.toHaveBeenCalled();
	expect(JSON.stringify(requests[0])).not.toContain("image_url");
});
