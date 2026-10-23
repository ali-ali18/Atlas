import { describe, expect, it } from "vitest";
import { BOT_REPLY_SLA_MS, botOverdueLabel, formatOpenBotRequests, isBotRequestOverdue, parseBotLinkCard } from "./index.js";

const now = new Date("2026-10-23T12:00:00.000Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

describe("prazo de resposta entre bots", () => {
	it("atrasado só em aberto e depois de 30 min", () => {
		expect(BOT_REPLY_SLA_MS).toBe(30 * 60_000);
		expect(isBotRequestOverdue({ status: "delivered", createdAt: ago(29) }, now)).toBe(false);
		expect(isBotRequestOverdue({ status: "delivered", createdAt: ago(30) }, now)).toBe(true);
		expect(isBotRequestOverdue({ status: "pending", createdAt: ago(45) }, now)).toBe(true);
		expect(isBotRequestOverdue({ status: "waiting", createdAt: ago(45) }, now)).toBe(true);
		for (const status of ["replied", "reply_delivered", "closed", "failed"]) {
			expect(isBotRequestOverdue({ status, createdAt: ago(120) }, now)).toBe(false);
		}
	});

	it("rótulo para o usuário diz se o pedido nem chegou ou se falta a resposta", () => {
		expect(botOverdueLabel("Bobinho", "delivered")).toBe("Bobinho ainda não respondeu");
		expect(botOverdueLabel("Bobinho", "pending")).toBe("Bobinho ainda não recebeu o pedido");
	});

	it("bloco do prompt: só pedidos em aberto das últimas 24 h, no máximo 5, com atraso marcado", () => {
		expect(formatOpenBotRequests([], now)).toBeNull();
		expect(formatOpenBotRequests([{ botName: "Bobinho", title: "PDF", status: "replied", createdAt: ago(5) }], now)).toBeNull();
		expect(formatOpenBotRequests([{ botName: "Bobinho", title: "PDF", status: "delivered", createdAt: ago(60 * 25) }], now)).toBeNull();
		const block = formatOpenBotRequests(
			[
				{ botName: "Bobinho", title: "PDF da Semana 2", status: "delivered", createdAt: ago(45) },
				{ botName: "Zeca", title: "Cotação", status: "pending", createdAt: ago(5) },
			],
			now,
		)!;
		expect(block).toContain("[open_bot_requests]");
		expect(block).toContain('- Bobinho: "PDF da Semana 2" (sent 45 min ago, no reply yet, overdue)');
		expect(block).toContain('- Zeca: "Cotação" (sent 5 min ago, no reply yet)');
		expect(block).toContain("Do not present their result as done");
		const many = formatOpenBotRequests(Array.from({ length: 8 }, (_, i) => ({ botName: `B${i}`, title: "t", status: "delivered", createdAt: ago(1) })), now)!;
		expect(many.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(5);
	});

	it("marcador 'enviou' guarda o atraso", () => {
		const card = { v: 1, kind: "sent", botMessageId: "m1", botId: "b2", botName: "Bobinho", title: "PDF", overdue: { label: "Bobinho ainda não respondeu", at: now.toISOString() } };
		expect(parseBotLinkCard(JSON.stringify(card))).toEqual(card);
		const { overdue: _overdue, ...plain } = card;
		expect(parseBotLinkCard(JSON.stringify(plain))).toEqual(plain);
	});
});
