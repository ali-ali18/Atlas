import { describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import { getToolMeta } from "../tools/registry/tool-meta.js";
import { runEngineV3 } from "./loop.js";

// O executor real de `propose_connector` precisa do banco; aqui só importa que a tool rodou com sucesso.
const executeTool = vi.hoisted(() => vi.fn(async (name: string) => ({ summary: `${name} shown to the user.` })));
vi.mock("../tools/registry/execute.js", () => ({ executeTool }));
vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => ({ description: "configurado" })),
	getConversationUntrustedAt: vi.fn(async () => null),
}));

const reply = (content: string | null, calls: Array<{ id: string; name: string }> = []): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content, ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: JSON.stringify({ app: "notion" }) } })) } : {}) },
	finishReason: calls.length ? "tool_calls" : "stop",
});

describe("motor v3: endsTurn", () => {
	it("tool com endsTurn (sem cartão pendente) encerra o turno depois do lote, com o texto do passo", async () => {
		expect(getToolMeta("propose_connector")?.endsTurn).toBe(true);
		const script = [reply("Vou mostrar o conector.", [{ id: "p", name: "propose_connector" }]), reply("não deveria ser chamado")];
		let calls = 0;
		const result = await runEngineV3({
			manager: {} as SandboxManager,
			getSessionId: async () => "s",
			sandboxEnabled: false,
			model: "m",
			apiKey: "k",
			runId: "run-e",
			userId: "u",
			botId: "b",
			conversationId: "c",
			origin: "chat",
			humanTurn: true,
			messages: [{ role: "user", content: "Conecte o Notion" }],
			onEvent: () => undefined,
			streamChat: async () => {
				calls += 1;
				return script.shift()!;
			},
		});
		expect(executeTool).toHaveBeenCalledWith("propose_connector", { app: "notion" }, expect.anything());
		expect(calls).toBe(1);
		expect(result).toMatchObject({ text: "Vou mostrar o conector.", stop: { reason: "answered", detail: "ends_turn" } });
	});
});
