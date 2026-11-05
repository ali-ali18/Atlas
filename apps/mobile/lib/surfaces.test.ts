import { describe, expect, it } from "vitest";
import { chatChrome, chatSurface, routineSurface } from "./chat-surface";
import { SURFACE_RADIUS, surfaceColors } from "./surfaces";
import { themeColor } from "./color-tokens";

const HEX = /^#[0-9a-f]{6}$/i;

describe("surfaceColors", () => {
	it("escuro: valores medidos no app do Grok", () => {
		expect(surfaceColors("dark")).toEqual({
			screen: "#1a1a1a",
			surface: "#2c2c2e",
			surfaceEdge: "#373739",
			divider: "#373739",
			chromeFill: "#303032",
			chromeEdge: "#4f4f51",
			chromeControl: "#424146",
			sheet: "#1e1e1e",
			bubble: "#2c2c2c",
			chatCard: "#2e2e2f",
			chatCardControl: "#404042",
			link: "#136cd0",
			switchOff: "#3a3a3c",
			switchThumb: "#ffffff",
			inverseFill: "#ffffff",
			inverseInk: "#09090b",
		});
	});

	it("claro: vem dos tokens do tema", () => {
		const light = surfaceColors("light");
		expect(light.screen).toBe(themeColor("light", "background"));
		expect(light.surface).toBe(themeColor("light", "muted"));
		expect(light.surfaceEdge).toBe(themeColor("light", "border"));
		expect(light.divider).toBe(themeColor("light", "border"));
		expect(light.chromeFill).toBe(themeColor("light", "input"));
		expect(light.chromeEdge).toBe(themeColor("light", "border"));
		expect(light.sheet).toBe(themeColor("light", "popover"));
		expect(light.chatCard).toBe(light.bubble);
		expect(light.chatCardControl).toBe(themeColor("light", "input"));
		expect(light.link).toBe(themeColor("light", "info"));
	});

	it("o fundo de tela é o do tema nos dois modos (um padrão só)", () => {
		expect(surfaceColors("dark").screen).toBe(themeColor("dark", "background"));
		expect(surfaceColors("light").screen).toBe(themeColor("light", "background"));
	});

	it("o contorno do chrome é mais claro que o do cartão, e todas as cores são hex válidos", () => {
		for (const scheme of ["light", "dark"] as const) {
			for (const value of Object.values(surfaceColors(scheme))) expect(value).toMatch(HEX);
		}
		expect(surfaceColors("dark").chromeEdge > surfaceColors("dark").surfaceEdge).toBe(true);
	});

	it("a casca do cartão do chat é muito próxima do balão do bot e o botão secundário se destaca dela", () => {
		const lum = (hex: string) => Number.parseInt(hex.slice(1, 3), 16);
		const dark = surfaceColors("dark");
		expect(Math.abs(lum(dark.chatCard) - lum(dark.bubble))).toBeLessThanOrEqual(6);
		expect(lum(dark.chatCardControl) - lum(dark.chatCard)).toBeGreaterThanOrEqual(16);
		expect(dark.chatCard).not.toBe(dark.surface);
	});

	it("o botão de remover anexo é branco com traço escuro nos dois modos", () => {
		for (const scheme of ["light", "dark"] as const) {
			expect(surfaceColors(scheme).inverseFill).toBe("#ffffff");
			expect(surfaceColors(scheme).inverseInk).toBe("#09090b");
		}
	});

	it("o raio do cartão é 21", () => {
		expect(SURFACE_RADIUS).toBe(21);
	});
});

describe("reexports de chat-surface", () => {
	it("apontam para as mesmas cores", () => {
		for (const scheme of ["light", "dark"] as const) {
			const colors = surfaceColors(scheme);
			expect(chatChrome(scheme)).toEqual({ fill: colors.chromeFill, edge: colors.chromeEdge, control: colors.chromeControl });
			expect(chatSurface(scheme, "card")).toBe(colors.chatCard);
			expect(chatSurface(scheme, "bubble")).toBe(colors.bubble);
			expect(routineSurface(scheme)).toEqual({ screen: colors.screen, card: colors.surface, edge: colors.surfaceEdge, link: colors.link, off: colors.switchOff });
		}
	});
});
