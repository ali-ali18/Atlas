import assert from "node:assert/strict";
import test from "node:test";
import { apcaContrast, bubbleColors, readBubbleBotColor, withBubbleBotColor } from "./bot-bubble";

const rgbOf = (v: string): [number, number, number] => {
	const n = Number.parseInt(v.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

test("padrão é ligado; só false desliga", () => {
	assert.equal(readBubbleBotColor(undefined), true);
	assert.equal(readBubbleBotColor(null), true);
	assert.equal(readBubbleBotColor({}), true);
	assert.equal(readBubbleBotColor({ userBubbleBotColor: "x" }), true);
	assert.equal(readBubbleBotColor({ userBubbleBotColor: false }), false);
});

test("withBubbleBotColor preserva as outras chaves", () => {
	assert.deepEqual(withBubbleBotColor({ planMode: true }, false), { planMode: true, userBubbleBotColor: false });
	assert.equal(readBubbleBotColor(withBubbleBotColor(null, true)), true);
});

test("texto tem |Lc| >= 60 no APCA em cores claras, escuras e vivas", () => {
	for (const color of ["#ffff00", "#ffffff", "#000000", "#6366f1", "#22c55e", "#ef4444", "#0ea5e9", "#f59e0b", "#7c3aed"]) {
		const result = bubbleColors(color)!;
		assert.ok(Math.abs(apcaContrast(rgbOf(result.foreground), rgbOf(result.background))) >= 60, color);
	}
});

test("cor clara usa texto escuro e cor escura usa texto claro; inválida = null", () => {
	assert.equal(bubbleColors("#ffff00")?.foreground, "#111111");
	assert.equal(bubbleColors("#1e1b4b")?.foreground, "#ffffff");
	assert.equal(bubbleColors("azul"), null);
	assert.equal(bubbleColors(undefined), null);
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

test("cores de avatar: texto pelo APCA e fundo na cor original (azul usa texto branco)", () => {
	for (const [nome, entrada, background, foreground] of AVATAR_TABLE) {
		assert.deepEqual(bubbleColors(entrada), { background, foreground }, nome);
	}
});

test("toda cor de avatar atinge |Lc| >= 60", () => {
	for (const [nome, entrada] of AVATAR_TABLE) {
		const { background, foreground } = bubbleColors(entrada)!;
		assert.ok(Math.abs(apcaContrast(rgbOf(foreground), rgbOf(background))) >= 60, `${nome} APCA`);
	}
});

test("apcaContrast: valores de referência", () => {
	assert.equal(apcaContrast([0, 0, 0], [255, 255, 255]), 106);
	assert.equal(apcaContrast([255, 255, 255], [0, 0, 0]), -108);
});
