import { describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsResult, LlmMessage } from "@workspace/llm";
import { runComputerUse } from "./computer-use.js";
import { EMPTY_REPLY_FALLBACK_TEXT, EMPTY_REPLY_NOTE } from "./execution/task-state.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

/**
 * Bug #80: o modelo devolveu resposta vazia (sem texto, sem tool) e o run
 * fechava com "Não consegui concluir dentro do limite de passos" mesmo tendo
 * usado 11 de 24 passos. Agora: uma nova tentativa, depois o resumo honesto (A3).
 */
const OLD_STEP_LIMIT_MESSAGE = "limite de passos";
const reply = (content: string): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content },
	finishReason: "stop",
});

async function run(script: CompleteChatWithToolsResult[]) {
	const requests: Array<{ messages: LlmMessage[]; toolChoice?: unknown }> = [];
	let index = 0;
	const result = await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		sandboxEnabled: false,
		apiKey: "test",
		model: "m",
		runId: "run-empty",
		userId: "user-a",
		origin: "chat",
		messages: [{ role: "user", content: "Add charts and styling to the sheet." }],
		onEvent: () => undefined,
		streamChat: async (params) => {
			requests.push({ messages: JSON.parse(JSON.stringify(params.messages)) as LlmMessage[], toolChoice: params.toolChoice });
			return script[Math.min(index++, script.length - 1)]!;
		},
	});
	return { result, requests };
}

describe("resposta vazia do modelo", () => {
	it("tenta de novo com o pedido de continuar a tarefa e entrega a resposta", async () => {
		const { result, requests } = await run([reply(""), reply("Charts added to the sheet.")]);
		expect(result.text).toBe("Charts added to the sheet.");
		expect(requests).toHaveLength(2);
		expect(requests[1]!.messages.filter((m) => m.role === "system").map((m) => String(m.content))).toContain(EMPTY_REPLY_NOTE);
	});

	it("vazio de novo: chamada final sem tools resume o que foi feito, sem a mensagem antiga de passos", async () => {
		const { result, requests } = await run([reply(""), reply(""), reply("Done so far: data written. Missing: charts. Next: ask to retry.")]);
		expect(requests).toHaveLength(3);
		expect(requests[2]!.toolChoice).toBe("none");
		expect(result.text).toContain("Missing: charts");
		expect(result.text).not.toContain(OLD_STEP_LIMIT_MESSAGE);
	});

	it("sem resumo também: mensagem honesta, nunca a de limite de passos", async () => {
		const { result } = await run([reply("")]);
		expect(result.text).toBe(EMPTY_REPLY_FALLBACK_TEXT);
		expect(result.text).not.toContain(OLD_STEP_LIMIT_MESSAGE);
		expect(result.text).not.toContain("checkpoint");
	});
});
