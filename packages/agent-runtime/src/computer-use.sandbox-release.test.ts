import { describe, expect, it, vi } from "vitest";
import type { ChatTool, CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";
import { NATIVE_TOOL_GROUPS } from "./context/native-tools.js";
import { executeSandboxRelease } from "./tools/sandbox-release.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

const step = (name: string, args: Record<string, unknown> = {}): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id: "r1", type: "function", function: { name, arguments: JSON.stringify(args) } }] },
});
const done: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "Pronto." } };

async function run(input: { sandboxEnabled: boolean; stop?: (conversationId: string) => Promise<boolean>; script?: CompleteChatWithToolsResult[] }) {
	const offered: string[][] = [];
	const results: Array<{ name: string; ok: boolean; summary: string }> = [];
	const stopConversationSession = vi.fn(input.stop ?? (async () => true));
	const script = [...(input.script ?? [])];
	await runComputerUse({
		manager: { stopConversationSession } as unknown as SandboxManager,
		getSessionId: async () => "s1",
		sandboxEnabled: input.sandboxEnabled,
		apiKey: "test",
		model: "m",
		runId: "run-release",
		userId: "user-a",
		botId: "bot-a",
		conversationId: "conv-1",
		origin: "chat",
		contextEconomy: true,
		messages: [{ role: "user", content: "acabei, pode desligar o computador" }],
		maxSteps: 6,
		onEvent: (event) => {
			if (event.type === "tool_result") results.push({ name: event.name, ok: event.ok, summary: event.summary });
		},
		streamChat: async (params) => {
			offered.push((params.tools ?? []).map((tool: ChatTool) => tool.function.name));
			return script.shift() ?? done;
		},
	});
	return { offered, results, stopConversationSession };
}

describe("sandbox_release", () => {
	it("pertence ao grupo browser e só aparece com a VM ligada", async () => {
		expect(NATIVE_TOOL_GROUPS.browser.tools).toContain("sandbox_release");
		const withVm = await run({ sandboxEnabled: true });
		expect(withVm.offered[0]).toContain("sandbox_release");
		const noVm = await run({ sandboxEnabled: false });
		expect(noVm.offered[0]).not.toContain("sandbox_release");
	});

	it("o executor chama o desligamento da conversa do run", async () => {
		const { results, stopConversationSession } = await run({ sandboxEnabled: true, script: [step("sandbox_release"), done] });
		expect(stopConversationSession).toHaveBeenCalledWith("conv-1");
		expect(results[0]).toMatchObject({ name: "sandbox_release", ok: true });
		expect(results[0]!.summary).toContain("VM turned off");
	});

	it("falha de verdade vira erro com dica; sem VM ligada é só aviso", async () => {
		await expect(executeSandboxRelease({ manager: { stopConversationSession: async () => { throw new Error("docker fora"); } }, conversationId: "c" })).rejects.toThrow(/Could not turn the VM off \(docker fora\)/);
		await expect(executeSandboxRelease({ manager: { stopConversationSession: async () => true } })).rejects.toThrow(/no conversation VM/);
		const none = await executeSandboxRelease({ manager: { stopConversationSession: async () => false }, conversationId: "c" });
		expect(none.summary).toContain("already off");
	});
});
