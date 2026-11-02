import { describe, expect, it } from "vitest";
import { botColors } from "./bot-color";
const primary = { accent: "#e4e4e7", foreground: "#18181b" };

describe("botColors", () => {
	it("cor do bot vira o destaque com primeiro plano branco", () => {
		expect(botColors("#6366f1", primary)).toEqual({ accent: "#6366f1", foreground: "#ffffff" });
	});
	it("laranja (luminância acima de 0,3) é escurecido um pouco, sem perder o tom", () => {
		const { accent } = botColors("#ff6a00", primary);
		expect(accent).not.toBe("#ff6a00");
		expect(accent.startsWith("#e")).toBe(true);
	});
	it("cor muito clara (bot branco) é escurecida: nunca branco sobre branco", () => {
		const { accent, foreground } = botColors("#ffffff", primary);
		expect(accent).not.toBe("#ffffff");
		expect(foreground).toBe("#ffffff");
	});
	it("sem cor válida cai no primary do tema", () => {
		expect(botColors(undefined, primary)).toBe(primary);
		expect(botColors("azul", primary)).toBe(primary);
	});
});
