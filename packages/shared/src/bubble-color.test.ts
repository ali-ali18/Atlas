import { describe, expect, it } from "vitest";
import { apcaContrast, bubbleColors } from "./bubble-color";

const rgbOf = (v: string): [number, number, number] => {
	const n = Number.parseInt(v.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

describe("cor do balão do usuário", () => {
	it("texto tem |Lc| >= 60 no APCA em cores claras, escuras e vivas", () => {
		for (const color of ["#ffff00", "#ffffff", "#000000", "#6366f1", "#22c55e", "#ef4444", "#0ea5e9", "#f59e0b", "#7c3aed"]) {
			const result = bubbleColors(color)!;
			expect(Math.abs(apcaContrast(rgbOf(result.foreground), rgbOf(result.background))), color).toBeGreaterThanOrEqual(60);
		}
	});

	it("cor clara usa texto escuro e cor escura usa texto claro; inválida = null", () => {
		expect(bubbleColors("#ffff00")?.foreground).toBe("#111111");
		expect(bubbleColors("#1e1b4b")?.foreground).toBe("#ffffff");
		expect(bubbleColors("azul")).toBeNull();
		expect(bubbleColors(undefined)).toBeNull();
	});

	const AVATAR_TABLE: [string, string, string, string][] = [
		["Preto", "#000000", "#000000", "#ffffff"],
		["Marrom", "#936439", "#936439", "#ffffff"],
		["Vermelho", "#FF263C", "#ff263c", "#ffffff"],
		["Laranja", "#FF6700", "#ff6700", "#ffffff"],
		["Amarelo", "#FF9800", "#ff9800", "#111111"],
		["Verde", "#00C972", "#00c972", "#111111"],
		["Turquesa", "#00BCA6", "#1ec4b0", "#111111"],
		["Azul", "#1084FE", "#1084fe", "#ffffff"],
		["Violeta", "#9159FE", "#9159fe", "#ffffff"],
		["Rosa", "#FF309B", "#ff309b", "#ffffff"],
		["Cinza", "#777777", "#777777", "#ffffff"],
	];

	it("cores de avatar: texto pelo APCA e fundo na cor original (azul usa texto branco)", () => {
		for (const [nome, entrada, background, foreground] of AVATAR_TABLE) {
			expect(bubbleColors(entrada), nome).toEqual({ background, foreground });
		}
	});

	it("toda cor de avatar atinge |Lc| >= 60", () => {
		for (const [nome, entrada] of AVATAR_TABLE) {
			const { background, foreground } = bubbleColors(entrada)!;
			expect(Math.abs(apcaContrast(rgbOf(foreground), rgbOf(background))), `${nome} APCA`).toBeGreaterThanOrEqual(60);
		}
	});

	it("apcaContrast: valores de referência", () => {
		expect(apcaContrast([0, 0, 0], [255, 255, 255])).toBe(106);
		expect(apcaContrast([255, 255, 255], [0, 0, 0])).toBe(-108);
	});
});
