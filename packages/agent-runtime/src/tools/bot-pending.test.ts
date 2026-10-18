import { describe, expect, it, vi } from "vitest";
import { buildBotPendingItem, needFromCardRow, type BotNeed, type PendingJevVerdict } from "@workspace/shared";
import { executeDecideBotPending, judgeWithJev, shouldExposeDecideBotPending, type DecideBotPendingDeps } from "./bot-pending.js";
import type { JevRuntime } from "../jev/decide.js";

const confirm = (extra: Record<string, unknown>) =>
	JSON.stringify({ v: 1, kind: "confirm", confirmId: "c1", title: "Executar este comando?", status: "pending", ...extra });

function needFor(content: string, intent?: { action: string; actionClass?: "write" | "irreversible" }): BotNeed {
	return needFromCardRow({ rowId: "card1", conversationId: "conv-dev", role: "confirm", content, intent })!;
}

const ctx = { userId: "u1", botId: "orq", conversationId: "conv-orq", origin: "bot" as const };
const message = { id: "bm1", userId: "u1", toBotId: "dev", fromBotId: "orq", title: "Rodar testes", content: "rode os testes", fromConversationId: "conv-orq", fromRunId: "r0", toConversationId: "conv-dev", toRunId: "r1", rootId: "bm1", createdAt: new Date(), deliveredAt: null };

function setup(over: { need: BotNeed; enabled?: boolean; attended?: boolean; jev?: PendingJevVerdict }) {
	const calls = { queued: [] as unknown[], escalated: 0, judged: 0 };
	const deps: Partial<DecideBotPendingDeps> = {
		enabled: async () => over.enabled ?? true,
		attended: async () => over.attended ?? true,
		find: async () => ({ message, need: over.need, botName: "Dev" }),
		userRequest: async () => "rode os testes do repo",
		autoCount: async () => 0,
		queue: async (_conv, card) => (calls.queued.push(card), true),
		escalate: async () => (calls.escalated++, 1),
		judge: async () => (calls.judged++, over.jev ?? null),
		botName: async () => "Principal",
	};
	return { calls, deps };
}

const yes: PendingJevVerdict = { withinScope: 0.95, reversible: 0.95, harmlessOutward: 0.95 };
const commandNeed = () => needFor(confirm({ devApproval: { kind: "command", command: "pnpm test", cwd: "/w" } }));

describe("decide_bot_pending", () => {
	it("exposição: só ligado, com 2+ bots e humano", () => {
		expect(shouldExposeDecideBotPending({ origin: "bot", botCount: 2, enabled: true })).toBe(true);
		expect(shouldExposeDecideBotPending({ origin: "bot", botCount: 2, enabled: false })).toBe(false);
		expect(shouldExposeDecideBotPending({ origin: "routine", botCount: 2, enabled: true })).toBe(false);
		expect(shouldExposeDecideBotPending({ origin: "chat", botCount: 1, enabled: true })).toBe(false);
	});

	it("orquestrador e Jev aprovam: grava a decisão na fila, sem card para o usuário", async () => {
		const { calls, deps } = setup({ need: commandNeed(), jev: yes });
		const out = await executeDecideBotPending({ handle: "card1", decision: "approve", reason: "só roda os testes", confidence: 0.95 }, ctx, deps);
		expect(JSON.parse(out.summary)).toMatchObject({ decided: true, applied: "approved" });
		expect(calls.queued).toHaveLength(1);
		expect(calls.queued[0]).toMatchObject({ kind: "auto-decision", decision: "approved", deciderName: "Principal", withJev: true, status: "queued" });
		expect(calls.escalated).toBe(0);
	});

	it("recusa automática leva o motivo como comentário", async () => {
		const { calls, deps } = setup({ need: commandNeed(), jev: { withinScope: 0.05, reversible: 0.9, harmlessOutward: 0.9 } });
		await executeDecideBotPending({ handle: "card1", decision: "reject", reason: "fora do pedido", confidence: 0.9 }, ctx, deps);
		expect(calls.queued[0]).toMatchObject({ decision: "rejected", feedback: "fora do pedido" });
	});

	it("Jev indisponível: escala ao usuário", async () => {
		const { calls, deps } = setup({ need: commandNeed(), jev: undefined });
		const out = await executeDecideBotPending({ handle: "card1", decision: "approve", reason: "ok", confidence: 0.99 }, ctx, deps);
		expect(JSON.parse(out.summary)).toMatchObject({ decided: false, escalated: true });
		expect(calls.queued).toHaveLength(0);
		expect(calls.escalated).toBe(1);
	});

	it("configuração desligada: escala, sem consultar o Jev", async () => {
		const { calls, deps } = setup({ need: commandNeed(), enabled: false, jev: yes });
		await executeDecideBotPending({ handle: "card1", decision: "approve", reason: "ok", confidence: 1 }, ctx, deps);
		expect(calls.escalated).toBe(1);
		expect(calls.queued).toHaveLength(0);
	});

	it("cadeia sem humano: escala (comportamento de hoje)", async () => {
		const { calls, deps } = setup({ need: commandNeed(), attended: false, jev: yes });
		await executeDecideBotPending({ handle: "card1", decision: "approve", reason: "ok", confidence: 1 }, ctx, deps);
		expect(calls.escalated).toBe(1);
		expect(calls.queued).toHaveLength(0);
	});

	it("comando bloqueado e MCP irreversível: escala sem nem chamar o Jev", async () => {
		const hard = setup({ need: needFor(confirm({ devApproval: { kind: "command", command: "git push --force origin main", cwd: "/w" } })), jev: yes });
		await executeDecideBotPending({ handle: "card1", decision: "approve", reason: "ok", confidence: 1 }, ctx, hard.deps);
		expect(hard.calls).toMatchObject({ escalated: 1, judged: 0 });
		expect(hard.calls.queued).toHaveLength(0);

		const irreversible = setup({ need: needFor(confirm({ title: "Gmail: executar enviar?", description: "to: x" }), { action: "mcp-call", actionClass: "irreversible" }), jev: yes });
		await executeDecideBotPending({ handle: "card1", decision: "approve", reason: "ok", confidence: 1 }, ctx, irreversible.deps);
		expect(irreversible.calls).toMatchObject({ escalated: 1, judged: 0 });
	});

	it("decision escalate sempre manda ao usuário", async () => {
		const { calls, deps } = setup({ need: commandNeed(), jev: yes });
		await executeDecideBotPending({ handle: "card1", decision: "escalate" }, ctx, deps);
		expect(calls.escalated).toBe(1);
		expect(calls.queued).toHaveLength(0);
	});

	it("questionário: responde sozinho com escolha válida; inválida escala", async () => {
		const content = JSON.stringify({ v: 1, kind: "questionnaire", questionnaireId: "qq", title: "Qual?", status: "pending", items: [{ name: "env", prompt: "Ambiente", required: true, choices: [{ value: "dev" }, { value: "prod" }] }] });
		const need = needFromCardRow({ rowId: "card1", conversationId: "conv-dev", role: "questionnaire", content })!;
		const ok = setup({ need });
		await executeDecideBotPending({ handle: "card1", decision: "answer", answers: { env: "dev" }, reason: "pedido diz dev" }, ctx, ok.deps);
		expect(ok.calls.queued[0]).toMatchObject({ decision: "answered", answers: { env: "dev" }, withJev: false });
		const bad = setup({ need });
		await executeDecideBotPending({ handle: "card1", decision: "answer", answers: { env: "staging" } }, ctx, bad.deps);
		expect(bad.calls.escalated).toBe(1);
		expect(bad.calls.queued).toHaveLength(0);
	});

	it("item que não existe (ou já resolvido) vira erro de tool", async () => {
		const { deps } = setup({ need: commandNeed() });
		await expect(executeDecideBotPending({ handle: "x", decision: "approve" }, ctx, { ...deps, find: async () => null })).rejects.toThrow(/não encontrado|já resolvido/);
	});
});

describe("judgeWithJev", () => {
	const item = buildBotPendingItem({ rowId: "r", role: "confirm", content: confirm({ devApproval: { kind: "command", command: "pnpm test", cwd: "/w" } }) })!;
	const input = { item, userRequest: "rode os testes", delegatedTask: "rode os testes", proposal: { decision: "approve" as const, reason: "ok", confidence: 0.9 } };

	it("sem Jev (off ou sem cliente): null", async () => {
		expect(await judgeWithJev({ ...input, rt: undefined })).toBeNull();
		expect(await judgeWithJev({ ...input, rt: { ask: vi.fn(), modes: { pending: "off" } } })).toBeNull();
		expect(await judgeWithJev({ ...input, rt: { ask: vi.fn(), modes: { pending: "shadow" } } })).toBeNull();
	});

	it("falha do Jev: null (vai ao usuário)", async () => {
		const rt: JevRuntime = { ask: vi.fn().mockRejectedValue(new Error("boom")), modes: { pending: "on" } };
		expect(await judgeWithJev({ ...input, rt })).toBeNull();
	});

	it("Jev on: devolve as três probabilidades e não envia segredos", async () => {
		const ask = vi.fn().mockResolvedValue({ answers: { within_scope: 0.9, reversible: 0.8, harmless_outward: 1 } });
		const secret = "abcdefghijklmnop12345";
		const verdict = await judgeWithJev({ ...input, item: { ...item, preview: `curl -H "Authorization: Bearer ${secret}"` }, rt: { ask, modes: { pending: "on" } } });
		expect(verdict).toEqual({ withinScope: 0.9, reversible: 0.8, harmlessOutward: 1 });
		expect(JSON.stringify(ask.mock.calls[0]![0].state)).not.toContain(secret);
	});
});
