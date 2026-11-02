import assert from "node:assert/strict";
import test from "node:test";
import { readBubbleBotColor, withBubbleBotColor } from "./bot-bubble";

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
