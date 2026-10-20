import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import {
	getBotProfile,
	persistJevStatusCard,
	saveSkillPendingIntent,
	setAccountAutonomy,
	setBotAutonomy,
	updateBot,
} from "@workspace/db";
import { buildMcpToolset } from "./mcp/registry.js";
import type { McpRuntime } from "./mcp/runtime.js";
import { runComputerUse } from "./computer-use.js";

/**
 * F10 — gate único de autonomia: conectores, perfil, skills, rotinas e
 * `set_autonomy`. LLM mockado; nada de rede.
 */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => null),
		saveSkillPendingIntent: vi.fn(async () => undefined),
		findExecutedConfirmCall: vi.fn(async () => null),
		persistJevStatusCard: vi.fn(async () => undefined),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		updateBot: vi.fn(async () => ({})),
		loadAutonomyContext: vi.fn(async () => ({ accountRaw: null, botRaw: null, botName: "Taldo" })),
		setBotAutonomy: vi.fn(async () => true),
		setAccountAutonomy: vi.fn(async () => undefined),
	};
});

const erp = {
	id: "conn-erp",
	slug: "erp",
	name: "ERP",
	disabledTools: [],
	tools: [
		{
			name: "criar_proposta",
			description: "Cria proposta",
			inputSchema: { type: "object", required: ["cliente", "tipo"], properties: { cliente: { type: "string" }, tipo: { type: "string", enum: ["venda", "servico"] } } },
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		{
			name: "sem_schema",
			description: "Sem schema",
			inputSchema: { type: "object" },
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		{
			name: "listar",
			description: "Lista",
			inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string" } } },
			annotations: { readOnlyHint: true },
		},
	],
};

async function run(autonomy: "balanced" | "autonomous", name: string, args: Record<string, unknown>) {
	const call = vi.fn(async () => ({ ok: true, text: "feito", truncated: false }));
	const mcp: McpRuntime = { toolset: buildMcpToolset([erp], { autonomy: { level: autonomy, exceptions: [] } }), call };
	const events: Array<Record<string, unknown> & { type: string }> = [];
	const queue: CompleteChatWithToolsResult[] = [
		{ model: "m", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } },
		{ model: "m", message: { role: "assistant", content: "Pronto." } },
	];
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => { throw new Error("nao deve criar sessao"); },
		sandboxEnabled: false,
		model: "m",
		apiKey: "test",
		messages: [{ role: "user", content: "crie a proposta" }],
		botId: "bot-1",
		userId: "user-1",
		conversationId: "conv-v",
		runId: "run-v",
		origin: "chat",
		maxSteps: 4,
		mcp,
		autonomy: { level: autonomy, exceptions: [] },
		onEvent: (event) => { events.push(event as never); },
		streamChat: async () => {
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
	});
	const result = events.find((e) => e.type === "tool_result") as { ok?: boolean; summary?: string } | undefined;
	return { call, result, confirms: events.filter((e) => e.type === "confirm") };
}

describe("validação de argumentos antes do card", () => {
	beforeEach(() => { vi.clearAllMocks(); });

	it("campo obrigatório ausente: sem card, sem pending, erro com os campos", async () => {
		const { call, confirms, result } = await run("balanced", "mcp__erp__criar_proposta", { tipo: "venda" });
		expect(confirms).toHaveLength(0);
		expect(saveSkillPendingIntent).not.toHaveBeenCalled();
		expect(call).not.toHaveBeenCalled();
		expect(result?.ok).toBe(false);
		expect(result?.summary).toContain("- cliente:");
	});

	it("string vazia e enum inválido são apontados", async () => {
		const { result, confirms } = await run("balanced", "mcp__erp__criar_proposta", { cliente: "  ", tipo: "x" });
		expect(confirms).toHaveLength(0);
		expect(result?.summary).toContain("- cliente:");
		expect(result?.summary).toContain("- tipo: valor inválido");
	});

	it("escrita liberada (autônomo) também não executa incompleta", async () => {
		const { call, result } = await run("autonomous", "mcp__erp__criar_proposta", { tipo: "venda" });
		expect(call).not.toHaveBeenCalled();
		expect(result?.ok).toBe(false);
	});

	it("sem schema segue como antes (card)", async () => {
		const { confirms } = await run("balanced", "mcp__erp__sem_schema", {});
		expect(confirms).toHaveLength(1);
	});

	it("válido: card criado como antes", async () => {
		const { confirms } = await run("balanced", "mcp__erp__criar_proposta", { cliente: "Ana", tipo: "venda" });
		expect(confirms).toHaveLength(1);
		expect(saveSkillPendingIntent).toHaveBeenCalled();
	});

	it("leitura não é bloqueada pela validação", async () => {
		const { call } = await run("balanced", "mcp__erp__listar", {});
		expect(call).toHaveBeenCalled();
	});
});
