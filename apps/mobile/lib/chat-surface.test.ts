import { describe, expect, it } from "vitest";

import { chatCardEdge, chatCardSkin, chatSurface } from "./chat-surface";
import { colorTokens } from "./color-tokens";
import { RING_GAP_PT, RING_STROKE_PT } from "./shape-ring";
import { surfaceColors } from "./surfaces";

describe("pele do cartão do chat (tabela e propostas)", () => {
	it("no escuro é a casca do cartão do chat: fundo, contorno e raio 21", () => {
		const colors = surfaceColors("dark");
		expect(chatCardSkin("dark")).toEqual({ backgroundColor: colors.chatCard, borderWidth: 1, borderColor: colors.surfaceEdge, borderRadius: 21 });
		expect(chatCardEdge("dark")).toBe(colors.surfaceEdge);
	});
	it("no claro valem os tokens do tema, e o fundo é o mesmo da tabela", () => {
		expect(chatCardSkin("light").backgroundColor).toBe(chatSurface("light", "card"));
		expect(chatCardEdge("light")).toBe(colorTokens.light.border);
	});
});

describe("contorno da forma escolhida", () => {
	it("fica rente à forma: respiro e traço finos", () => {
		expect(RING_GAP_PT).toBeGreaterThan(0);
		expect(RING_GAP_PT + RING_STROKE_PT).toBeLessThanOrEqual(5);
	});
});
