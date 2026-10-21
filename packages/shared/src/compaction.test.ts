import { describe, expect, it } from "vitest";
import { compactionPercent, formatCompactionLine, formatTokensPt, parseCompactCommand } from "./compaction.js";
import { isConversationCardRole, parseConversationCard, serializeConversationCard } from "./skill-card.js";

describe("comando /compact", () => {
	it("aceita só o comando, com ou sem foco; outro texto não é o comando", () => {
		expect(parseCompactCommand("/compact")).toEqual({});
		expect(parseCompactCommand("  /compact  ")).toEqual({});
		expect(parseCompactCommand("/compact foque nas decisões do pedido")).toEqual({ focus: "foque nas decisões do pedido" });
		expect(parseCompactCommand("/compact\nfoque em A\ne B")).toEqual({ focus: "foque em A\ne B" });
		expect(parseCompactCommand("/compact".concat(" x".repeat(400)))?.focus?.length).toBeLessThanOrEqual(500);
		for (const text of ["compact", "/compactar", "/compactx foco", "use /compact", "", "/skill x"]) expect(parseCompactCommand(text)).toBeNull();
	});

	it("números do cartão em português", () => {
		expect(formatTokensPt(48_200)).toBe("48,2 mil");
		expect(formatTokensPt(6_100)).toBe("6,1 mil");
		expect(formatTokensPt(950)).toBe("950");
		expect(compactionPercent(48_200, 6_100)).toBe(87);
		expect(compactionPercent(0, 0)).toBe(0);
		expect(compactionPercent(100, 150)).toBe(0);
		expect(formatCompactionLine(48_200, 6_100)).toBe("48,2 mil → 6,1 mil tokens (−87%)");
	});

	it("cartão persistido sobrevive ao ciclo e descarta formato inválido", () => {
		expect(isConversationCardRole("compaction")).toBe(true);
		const card = { v: 1 as const, kind: "compaction" as const, before: 48_200, after: 6_100, summary: "Objetivo: montar a proposta.", focus: "decisões" };
		expect(parseConversationCard(serializeConversationCard(card))).toEqual(card);
		expect(parseConversationCard(JSON.stringify({ v: 1, kind: "compaction", before: 10, after: 5 }))).toBeNull();
		expect(parseConversationCard(JSON.stringify({ v: 1, kind: "compaction", before: -1, after: 5, summary: "x" }))).toBeNull();
		expect(parseConversationCard(JSON.stringify({ ...card, summary: "a".repeat(20_000) })) && (parseConversationCard(JSON.stringify({ ...card, summary: "a".repeat(20_000) })) as { summary: string }).summary.length).toBe(12_000);
	});
});
