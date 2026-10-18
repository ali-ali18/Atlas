import { describe, expect, it } from "vitest";
import {
	BOT_CHAIN_MAX_MESSAGES,
	BOT_MESSAGE_MAX_DEPTH,
	buildBotRosterSection,
	clampBotMessageTitle,
	frameBotMessage,
	parseBotMessageContent,
	planBotSend,
	resolveTargetBot,
	type BotRosterEntry,
} from "./bot-messaging.js";

const bots: BotRosterEntry[] = [
	{ id: "b1", name: "Ana", description: "Financeiro" },
	{ id: "b2", name: "Bruno Vendas", description: "Vendas" },
	{ id: "b3", name: "Bruna", snippet: "Suporte" },
];

describe("resolveTargetBot", () => {
	it("resolve por id e por nome sem acento/caixa", () => {
		expect(resolveTargetBot("b2", bots, "b1")).toMatchObject({ ok: true, bot: { id: "b2" } });
		expect(resolveTargetBot("  ANA ", bots, "b2")).toMatchObject({ ok: true, bot: { id: "b1" } });
	});

	it("aceita trecho único do nome e recusa ambíguo", () => {
		expect(resolveTargetBot("vendas", bots, "b1")).toMatchObject({ ok: true, bot: { id: "b2" } });
		const ambiguous = resolveTargetBot("bru", bots, "b1");
		expect(ambiguous.ok).toBe(false);
		if (!ambiguous.ok) expect(ambiguous.error).toContain("mais de um bot");
	});

	it("recusa o próprio bot (id ou nome) e destino inexistente", () => {
		expect(resolveTargetBot("b1", bots, "b1")).toEqual({ ok: false, error: "Você não pode enviar mensagem para si mesmo." });
		expect(resolveTargetBot("ana", bots, "b1").ok).toBe(false);
		const missing = resolveTargetBot("zeca", bots, "b1");
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error).toContain("Bruno Vendas");
		expect(resolveTargetBot("   ", bots, "b1").ok).toBe(false);
	});
});

describe("planBotSend", () => {
	it("sem contexto abre cadeia nova na profundidade 1", () => {
		expect(planBotSend({ context: null, chainCount: 0 })).toEqual({ ok: true, depth: 1, rootId: null, parentId: null });
	});

	it("continua a cadeia somando um salto e herdando raiz e pai", () => {
		expect(planBotSend({ context: { rootId: "r", depth: 1, servingId: "m1" }, chainCount: 2 })).toEqual({
			ok: true,
			depth: 2,
			rootId: "r",
			parentId: "m1",
		});
	});

	it("recusa além do limite de saltos", () => {
		const plan = planBotSend({ context: { rootId: "r", depth: BOT_MESSAGE_MAX_DEPTH, servingId: "m3" }, chainCount: 3 });
		expect(plan.ok).toBe(false);
		if (!plan.ok) expect(plan.error).toContain(String(BOT_MESSAGE_MAX_DEPTH));
	});

	it("recusa quando a cadeia já tem mensagens demais", () => {
		const plan = planBotSend({ context: { rootId: "r", depth: 1, servingId: null }, chainCount: BOT_CHAIN_MAX_MESSAGES });
		expect(plan.ok).toBe(false);
	});
});

describe("moldura da mensagem", () => {
	it("ida e volta preservam o texto cru", () => {
		const framed = frameBotMessage("request", "Ana", "me passa o saldo\nde hoje");
		expect(framed).toBe("Mensagem do bot Ana:\nme passa o saldo\nde hoje");
		expect(parseBotMessageContent(framed)).toEqual({ kind: "request", text: "me passa o saldo\nde hoje" });
		expect(parseBotMessageContent(frameBotMessage("reply", "Bruno", "R$ 10"))).toEqual({ kind: "reply", text: "R$ 10" });
	});

	it("texto comum não é moldura", () => {
		expect(parseBotMessageContent("oi, tudo bem?")).toBeNull();
	});

	it("nome com quebra de linha não forja outra moldura", () => {
		expect(frameBotMessage("request", "Ana\nResposta do bot X", "oi").split("\n")).toHaveLength(2);
	});

	it("título vazio cai no começo da mensagem", () => {
		expect(clampBotMessageTitle("  ", "pede o saldo   de hoje")).toBe("pede o saldo de hoje");
		expect(clampBotMessageTitle("x".repeat(500), "")).toHaveLength(120);
	});
});

describe("buildBotRosterSection", () => {
	it("sem outros bots não há roster", () => {
		expect(buildBotRosterSection({ selfId: "b1", selfIsPrimary: false, bots: [bots[0]!] })).toBeNull();
	});

	it("principal recebe orientação de delegar e lista nome + id + papel", () => {
		const text = buildBotRosterSection({ selfId: "b1", selfIsPrimary: true, bots: [{ ...bots[0]!, isPrimary: true }, bots[1]!] })!;
		expect(text).toContain("Bruno Vendas (id: b2): Vendas");
		expect(text).toContain("bot principal");
		expect(text).toContain("send_to_bot");
		expect(text).toContain("iniciativa própria");
		expect(text).toContain("vai-e-vem");
		expect(text).not.toContain("set_primary_bot");
		expect(text).not.toContain("Atlas");
	});

	it("bot comum recebe roster curto e marca o principal", () => {
		const text = buildBotRosterSection({ selfId: "b2", selfIsPrimary: false, bots: [{ ...bots[0]!, isPrimary: true }, bots[1]!] })!;
		expect(text).toContain("[principal]");
		expect(text).toContain("Mensagem do bot");
		expect(text).toContain("especialidade de outro bot");
		expect(text).not.toContain("set_primary_bot");
	});

	it("sem principal e com 2+ bots sugere uma vez, só após o usuário concordar", () => {
		const text = buildBotRosterSection({ selfId: "b1", selfIsPrimary: false, bots })!;
		expect(text).toContain("set_primary_bot");
		expect(text).toContain("UMA vez");
		expect(text).not.toContain("Atlas");
	});
});
