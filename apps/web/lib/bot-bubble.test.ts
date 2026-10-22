import assert from "node:assert/strict";
import test from "node:test";
import { relativeLuminance } from "@/components/ui/templates/template-4/chat-context-panel/bot-accent";
import { apcaContrast, bubbleColors, contrastRatio, readBubbleBotColor, withBubbleBotColor } from "./bot-bubble";

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

test("texto tem contraste >= 4.5:1 em cores claras, escuras e vivas", () => {
	for (const color of ["#ffff00", "#ffffff", "#000000", "#6366f1", "#22c55e", "#ef4444", "#0ea5e9", "#f59e0b", "#7c3aed"]) {
		const result = bubbleColors(color)!;
		const hex = (v: string) => (v.length === 4 ? [...v.slice(1)].map((c) => c + c).join("") : v.slice(1));
		const toLum = (v: string) => { const n = Number.parseInt(hex(v), 16); return relativeLuminance([(n >> 16) & 255, (n >> 8) & 255, n & 255]); };
		assert.ok(contrastRatio(toLum(result.background), toLum(result.foreground)) >= 4.5, color);
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
	["Vermelho", "#FF263C", "#e22235", "#ffffff"],
	["Laranja", "#FF6700", "#c85100", "#ffffff"],
	["Amarelo", "#FF9800", "#ff9800", "#111111"],
	["Verde", "#00C972", "#00c972", "#111111"],
	["Turquesa", "#00BCA6", "#1ec4b0", "#111111"],
	["Azul", "#1084FE", "#0e75e1", "#ffffff"],
	["Violeta", "#9159FE", "#8652ea", "#ffffff"],
	["Rosa", "#FF309B", "#d92984", "#ffffff"],
	["Cinza", "#777777", "#727272", "#ffffff"],
];

const rgbOf = (v: string): [number, number, number] => {
	const n = Number.parseInt(v.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

test("cores de avatar: fundo e texto escolhidos pelo APCA (azul usa texto branco)", () => {
	for (const [nome, entrada, background, foreground] of AVATAR_TABLE) {
		assert.deepEqual(bubbleColors(entrada), { background, foreground }, nome);
	}
});

test("toda cor de avatar atinge WCAG >= 4.5 e |Lc| >= 60", () => {
	for (const [nome, entrada] of AVATAR_TABLE) {
		const { background, foreground } = bubbleColors(entrada)!;
		const ratio = contrastRatio(relativeLuminance(rgbOf(background)), relativeLuminance(rgbOf(foreground)));
		assert.ok(ratio >= 4.5, `${nome} WCAG ${ratio}`);
		assert.ok(Math.abs(apcaContrast(rgbOf(foreground), rgbOf(background))) >= 60, `${nome} APCA`);
	}
});

test("apcaContrast: valores de referência", () => {
	assert.equal(apcaContrast([0, 0, 0], [255, 255, 255]), 106);
	assert.equal(apcaContrast([255, 255, 255], [0, 0, 0]), -108);
});
