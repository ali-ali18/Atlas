import { describe, expect, it, vi } from "vitest";
import type { ChatTool, CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";
import { NATIVE_TOOL_GROUPS } from "./context/native-tools.js";
import { executeSandboxRelease, otherUseOfVm } from "./tools/sandbox-release.js";

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

async function run(input: { sandboxEnabled: boolean; origin?: string; activity?: { idleMs: number; busy: boolean } | null; stop?: (conversationId: string) => Promise<boolean>; script?: CompleteChatWithToolsResult[] }) {
	const offered: string[][] = [];
	const results: Array<{ name: string; ok: boolean; summary: string }> = [];
	const stopConversationSession = vi.fn(input.stop ?? (async () => true));
	const script = [...(input.script ?? [])];
	await runComputerUse({
		manager: { stopConversationSession, getConversationActivity: async () => input.activity ?? null } as unknown as SandboxManager,
		getSessionId: async () => "s1",
		sandboxEnabled: input.sandboxEnabled,
		apiKey: "test",
		model: "m",
		runId: "run-release",
		userId: "user-a",
		botId: "bot-a",
		conversationId: "conv-1",
		origin: (input.origin ?? "chat") as "chat",
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

	it("não é oferecida em rotina nem em webhook (sem humano para decidir desligar)", async () => {
		for (const origin of ["routine", "webhook"]) {
			const unattended = await run({ sandboxEnabled: true, origin });
			expect(unattended.offered[0]).not.toContain("sandbox_release");
		}
	});

	it("recusa desligar se a VM está em uso agora ou se outro run a usou há poucos segundos", async () => {
		const busy = await run({ sandboxEnabled: true, activity: { idleMs: 0, busy: true }, script: [step("sandbox_release"), done] });
		expect(busy.stopConversationSession).not.toHaveBeenCalled();
		expect(busy.results[0]).toMatchObject({ name: "sandbox_release", ok: false });
		expect(busy.results[0]!.summary).toMatch(/NOT turned off/);
		const recent = await run({ sandboxEnabled: true, activity: { idleMs: 4_000, busy: false }, script: [step("sandbox_release"), done] });
		expect(recent.stopConversationSession).not.toHaveBeenCalled();
		expect(recent.results[0]).toMatchObject({ ok: false });
		const idle = await run({ sandboxEnabled: true, activity: { idleMs: 120_000, busy: false }, script: [step("sandbox_release"), done] });
		expect(idle.stopConversationSession).toHaveBeenCalledWith("conv-1");
	});

	it("uso recente do PRÓPRIO run não conta como outro run", () => {
		const now = 1_000_000;
		expect(otherUseOfVm({ idleMs: 4_000, busy: false }, now - 4_500, now)).toBeNull();
		expect(otherUseOfVm({ idleMs: 4_000, busy: false }, now - 60_000, now)).toMatch(/another run/);
		expect(otherUseOfVm({ idleMs: 4_000, busy: false }, undefined, now)).toMatch(/another run/);
		expect(otherUseOfVm(null, undefined, now)).toBeNull();
	});

	it("falha de verdade vira erro com a mensagem real (nunca \"já estava desligada\"); sem VM ligada é só aviso", async () => {
		// Como o manager real: erro de Docker propaga; false só quando não havia VM ligada.
		await expect(executeSandboxRelease({ manager: { stopConversationSession: async () => { throw new Error("docker fora"); } }, conversationId: "c" })).rejects.toThrow(/Could not turn the VM off \(docker fora\)/);
		await expect(executeSandboxRelease({ manager: { stopConversationSession: async () => true } })).rejects.toThrow(/no conversation VM/);
		const none = await executeSandboxRelease({ manager: { stopConversationSession: async () => false }, conversationId: "c" });
		expect(none.summary).toContain("already off");
		const failed = await run({ sandboxEnabled: true, stop: async () => { throw new Error("docker fora"); }, script: [step("sandbox_release"), done] });
		expect(failed.results[0]).toMatchObject({ ok: false });
		expect(failed.results[0]!.summary).toContain("docker fora");
	});
});
