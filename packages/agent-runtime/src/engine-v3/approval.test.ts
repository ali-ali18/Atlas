import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { ComputerUseEvent } from "@workspace/shared";
import type { ComputerUseParams } from "../run-types.js";
import { APPROVAL_DECLINED, APPROVAL_PARKED, toolCallKey } from "./approval.js";
import { runEngineV3 } from "./loop.js";

// O executor real precisa de banco/VM: aqui só importa SE e QUANTAS vezes a tool nativa rodou.
const executeTool = vi.hoisted(() => vi.fn(async (name: string) => ({ summary: `${name} done.` })));
vi.mock("../tools/registry/execute.js", () => ({ executeTool }));
/** Decisões do dono por chave de chamada, como o cartão guarda no banco (aprovação vale uma vez). */
const decisions = vi.hoisted(() => new Map<string, "approved" | "declined">());
const pending = vi.hoisted(() => [] as Array<{ action: string; toolCall?: { callKey: string; tool: string } }>);
vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => ({ description: "configurado" })),
	getConversationUntrustedAt: vi.fn(async () => null),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	upsertTaskListCard: vi.fn(async () => undefined),
	saveSkillPendingIntent: vi.fn(async (input: { payload: { action: string; toolCall?: { callKey: string; tool: string } } }) => {
		pending.push(input.payload);
	}),
	takeToolCallApproval: vi.fn(async (_userId: string, _conversationId: string, callKey: string) => {
		const decision = decisions.get(callKey) ?? null;
		if (decision === "approved") decisions.delete(callKey);
		return decision;
	}),
}));

const call = (id: string, name: string, args: Record<string, unknown>): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
	finishReason: "tool_calls",
});
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content }, finishReason: "stop" });

async function runV3(script: CompleteChatWithToolsResult[], extra: Partial<ComputerUseParams> = {}) {
	const events: ComputerUseEvent[] = [];
	const queue = [...script];
	const result = await runEngineV3({
		manager: {} as SandboxManager,
		getSessionId: async () => "s",
		sandboxEnabled: true,
		model: "m",
		apiKey: "k",
		runId: "run1",
		userId: "user-a",
		botId: "bot-a",
		conversationId: "conv-1",
		origin: "chat",
		humanTurn: true,
		messages: [{ role: "user", content: "Compartilhe o painel de vendas" }],
		onEvent: (event) => {
			events.push(event);
		},
		streamChat: async () => {
			const next = queue.shift();
			if (!next) throw new Error("roteiro acabou");
			return next;
		},
		...extra,
	});
	const results = events.filter((event): event is Extract<ComputerUseEvent, { type: "tool_result" }> => event.type === "tool_result");
	const cards = events.filter((event): event is Extract<ComputerUseEvent, { type: "confirm" }> => event.type === "confirm");
	return { result, results, cards };
}

/** A tool pode estar adiada: a 1ª chamada só carrega o grupo; a 2ª é a de verdade. */
const twice = (name: string, args: Record<string, unknown>) => [call("a", name, args), call("b", name, args)];

beforeEach(() => {
	vi.clearAllMocks();
	decisions.clear();
	pending.length = 0;
});

describe("motor v3: ask em tool nativa usa o cartão genérico", () => {
	const share = { page_id: "p1", action: "create" };

	it("page_share (link público) no chat: cartão de confirmação + run estacionado, nada executado", async () => {
		const { result, cards, results } = await runV3([...twice("page_share", share), say("x")]);
		expect(result.stop).toEqual({ reason: "awaiting_confirmation", detail: "confirm" });
		expect(executeTool).not.toHaveBeenCalled();
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({ title: "Criar um link público do painel?", callKey: toolCallKey("page_share", share), confirmLabel: "Permitir", cancelLabel: "Agora não" });
		expect(cards[0]!.confirmId).toMatch(/^confirm-tool[0-9a-f]{8}-run1$/);
		expect(cards[0]!.title).not.toMatch(/page_share/);
		expect(results.at(-1)).toMatchObject({ name: "page_share", ok: true, summary: APPROVAL_PARKED });
		expect(pending).toEqual([expect.objectContaining({ action: "tool-call", toolCall: expect.objectContaining({ tool: "page_share", callKey: toolCallKey("page_share", share) }) })]);
	});

	it("aprovado: executa exatamente aquela chamada UMA vez; repetir pede de novo", async () => {
		decisions.set(toolCallKey("page_share", share), "approved");
		const { result, cards } = await runV3([...twice("page_share", share), call("c", "page_share", share), say("x")]);
		expect(executeTool).toHaveBeenCalledTimes(1);
		expect(executeTool).toHaveBeenCalledWith("page_share", share, expect.anything());
		expect(cards).toHaveLength(1);
		expect(result.stop?.reason).toBe("awaiting_confirmation");
	});

	it("aprovação de outros args não vale para esta chamada", async () => {
		decisions.set(toolCallKey("page_share", { page_id: "outro", action: "create" }), "approved");
		await runV3([...twice("page_share", share), say("x")]);
		expect(executeTool).not.toHaveBeenCalled();
	});

	it("recusado: não executa e volta erro honesto ao modelo", async () => {
		decisions.set(toolCallKey("page_share", share), "declined");
		const { results, result } = await runV3([...twice("page_share", share), say("Não criei o link.")]);
		expect(executeTool).not.toHaveBeenCalled();
		expect(results.at(-1)).toMatchObject({ ok: false, summary: APPROVAL_DECLINED });
		expect(result.text).toBe("Não criei o link.");
	});

	it("sandbox_download com cookies do navegador (credencial) pede cartão; sem a sessão roda direto", async () => {
		const url = { url: "https://example.com/a.pdf" };
		const withCookies = await runV3([...twice("sandbox_download", url), say("x")]);
		expect(withCookies.cards).toHaveLength(1);
		expect(withCookies.cards[0]!.title).toBe("Baixar o arquivo usando a sessão do navegador do computador do bot?");
		expect(executeTool).not.toHaveBeenCalled();
		const noCookies = await runV3([...twice("sandbox_download", { ...url, use_browser_session: false }), say("Baixei.")]);
		expect(noCookies.cards).toHaveLength(0);
		expect(executeTool).toHaveBeenCalledTimes(1);
	});

	it("rotina continua sem cartão: o que precisaria de aprovação é negado com motivo", async () => {
		const { cards, results, result } = await runV3([...twice("page_share", share), say("Não deu.")], { origin: "routine", humanTurn: false });
		expect(cards).toHaveLength(0);
		expect(executeTool).not.toHaveBeenCalled();
		expect(results.at(-1)!.summary).toMatch(/^Not available in this run/);
		expect(result.stop?.reason).toBe("answered");
	});

	it("lição confirm_always em tool nativa vira cartão", async () => {
		const query = { query: "preço do dólar" };
		const { cards, result } = await runV3([...twice("web_search", query), say("x")], {
			preToolRules: [{ id: "l1", scope: "bot", scopeKey: null, rule: { kind: "confirm_always", tool: "web_search" } }],
		});
		expect(cards).toHaveLength(1);
		expect(cards[0]!.callKey).toBe(toolCallKey("web_search", query));
		expect(executeTool).not.toHaveBeenCalled();
		expect(result.stop?.reason).toBe("awaiting_confirmation");
	});
});
