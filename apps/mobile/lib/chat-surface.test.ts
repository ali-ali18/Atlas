import { describe, expect, it, vi } from "vitest";

// O tema importa o nativewind (só roda no app): aqui basta saber que o claro usa o token.
vi.mock("./theme", () => ({ themeColor: (scheme: string, token: string) => `${scheme}:${token}` }));

import { chatCardEdge, chatCardSkin, chatSurface } from "./chat-surface";
import { RING_GAP_PT, RING_STROKE_PT } from "./shape-ring";

describe("pele do cartão do chat (tabela e propostas)", () => {
	it("no escuro é o cartão do Grok: fundo #1f1f1f, borda #313131, raio 21", () => {
		expect(chatCardSkin("dark")).toEqual({ backgroundColor: "#1f1f1f", borderWidth: 1, borderColor: "#313131", borderRadius: 21 });
		expect(chatCardEdge("dark")).toBe("#313131");
	});
	it("no claro valem os tokens do tema, e o fundo é o mesmo da tabela", () => {
		expect(chatCardSkin("light").backgroundColor).toBe(chatSurface("light", "card"));
		expect(chatCardEdge("light")).toBe("light:border");
	});
});

describe("contorno da forma escolhida", () => {
	it("fica rente à forma: respiro e traço finos", () => {
		expect(RING_GAP_PT).toBeGreaterThan(0);
		expect(RING_GAP_PT + RING_STROKE_PT).toBeLessThanOrEqual(5);
	});
});
