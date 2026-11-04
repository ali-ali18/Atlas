import { describe, expect, it } from "vitest";
import { chatChrome, chatSurface, routineSurface } from "./chat-surface";
import { SURFACE_RADIUS, surfaceColors } from "./surfaces";
import { themeColor } from "./color-tokens";

const HEX = /^#[0-9a-f]{6}$/i;

describe("surfaceColors", () => {
	it("escuro: valores medidos no app do Grok", () => {
		expect(surfaceColors("dark")).toEqual({
			screen: "#09090b",
			surface: "#2c2c2e",
			surfaceEdge: "#373739",
			divider: "#373739",
			chromeFill: "#2c2c2e",
			chromeEdge: "#4b4b4d",
			chromeControl: "#3e3d42",
			sheet: "#1c1c1e",
			bubble: "#202020",
			link: "#136cd0",
			switchOff: "#3a3a3c",
			switchThumb: "#ffffff",
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

	it("o raio do cartão é 21", () => {
		expect(SURFACE_RADIUS).toBe(21);
	});
});

describe("reexports de chat-surface", () => {
	it("apontam para as mesmas cores", () => {
		for (const scheme of ["light", "dark"] as const) {
			const colors = surfaceColors(scheme);
			expect(chatChrome(scheme)).toEqual({ fill: colors.chromeFill, edge: colors.chromeEdge, control: colors.chromeControl });
			expect(chatSurface(scheme, "card")).toBe(colors.surface);
			expect(chatSurface(scheme, "bubble")).toBe(colors.bubble);
			expect(routineSurface(scheme)).toEqual({ screen: colors.screen, card: colors.surface, edge: colors.surfaceEdge, link: colors.link, off: colors.switchOff });
		}
	});
});
