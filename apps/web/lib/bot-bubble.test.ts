import assert from "node:assert/strict";
import test from "node:test";
import { relativeLuminance } from "@/components/ui/templates/template-4/chat-context-panel/bot-accent";
import { bubbleColors, contrastRatio, readBubbleBotColor, withBubbleBotColor } from "./bot-bubble";

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
