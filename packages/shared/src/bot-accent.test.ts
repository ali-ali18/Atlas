import { describe, expect, it } from "vitest";
import { botAccent, relativeLuminance } from "./bot-accent.js";

function lum(hex: string) {
	const n = Number.parseInt(hex.slice(1), 16);
	return relativeLuminance([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
}

describe("botAccent", () => {
	it("cor escura é mantida, com primeiro plano branco", () => {
		expect(botAccent("#6366f1")).toEqual({ accent: "#6366f1", foreground: "#ffffff" });
	});

	it("cor muito clara é escurecida até o knob branco ter contraste >= 3:1", () => {
		const result = botAccent("#ffff00");
		expect(result).not.toBeNull();
		expect(lum(result!.accent)).toBeLessThanOrEqual(0.3);
		expect(1.05 / (lum(result!.accent) + 0.05)).toBeGreaterThanOrEqual(3);
	});

	it("branco vira um cinza escuro legível", () => {
		expect(lum(botAccent("#ffffff")!.accent)).toBeLessThanOrEqual(0.3);
	});

	it("aceita #rgb e rejeita valores inválidos", () => {
		expect(botAccent("#000")?.accent).toBe("#000000");
		expect(botAccent("red")).toBeNull();
		expect(botAccent(undefined)).toBeNull();
	});
});
