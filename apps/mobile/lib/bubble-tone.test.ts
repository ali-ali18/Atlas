import { describe, expect, it } from "vitest";
import { grokBubbleColors } from "./bubble-tone";

describe("balão do usuário no tom do Grok", () => {
	it("o laranja do avatar vira o do Grok (#c24f00) com texto branco", () => {
		expect(grokBubbleColors("#ff6801")).toEqual({ background: "#c24f01", foreground: "#ffffff" });
	});
	it("cor clara (texto escuro) segue o ajuste do web", () => {
		expect(grokBubbleColors("#fde047")?.foreground).toBe("#111111");
	});
	it("cor inválida: sem balão colorido", () => {
		expect(grokBubbleColors("laranja")).toBeNull();
		expect(grokBubbleColors(undefined)).toBeNull();
	});
	it("aceita #rgb", () => {
		expect(grokBubbleColors("#f60")?.foreground).toBe("#ffffff");
	});
});
