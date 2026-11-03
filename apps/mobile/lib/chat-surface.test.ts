import { describe, expect, it } from "vitest";

import { chatCardEdge, chatCardSkin, chatSurface } from "./chat-surface";
import { colorTokens } from "./color-tokens";
import { RING_SCALE } from "./shape-ring";
import { surfaceColors } from "./surfaces";

describe("pele do cartão do chat (tabela e propostas)", () => {
	it("no escuro é a superfície padrão do app: fundo, contorno e raio 21", () => {
		const colors = surfaceColors("dark");
		expect(chatCardSkin("dark")).toEqual({ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceEdge, borderRadius: 21 });
		expect(chatCardEdge("dark")).toBe(colors.surfaceEdge);
	});
	it("no claro valem os tokens do tema, e o fundo é o mesmo da tabela", () => {
		expect(chatCardSkin("light").backgroundColor).toBe(chatSurface("light", "card"));
		expect(chatCardEdge("light")).toBe(colorTokens.light.border);
	});
});

describe("contorno da forma escolhida", () => {
	it("é maior que a forma, com folga", () => {
		expect(RING_SCALE).toBeGreaterThan(1.1);
		expect(RING_SCALE).toBeLessThan(1.5);
	});
});
