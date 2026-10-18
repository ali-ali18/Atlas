import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DIVIDER_HEADROOM_PX,
	LANDING_LOCK_MS,
	MAX_OLDER_LOADS_FOR_ANCHOR,
	decideArrival,
	decideLanding,
	isPinned,
	landingScrollTop,
	resolveDividerAnchor,
	resumeAnchorId,
	shouldReanchor,
} from "./thread-position";

const all = ["a", "b", "hidden", "c", "d"];
const visible = ["a", "b", "c", "d"];

test("divisor: antes da primeira não lida visível", () => {
	assert.equal(resolveDividerAnchor(all, visible, "c"), "c");
	assert.equal(resolveDividerAnchor(all, visible, null), null);
});

test("divisor: âncora escondida (protocolo) vale a próxima visível, nunca uma anterior", () => {
	assert.equal(resolveDividerAnchor(all, visible, "hidden"), "c");
	assert.equal(resolveDividerAnchor(["a", "x", "y"], ["a"], "x"), null);
});

test("divisor: âncora fora da lista carregada não vira divisor", () => {
	assert.equal(resolveDividerAnchor(all, visible, "zzz"), null);
});

test("pouso: sem não lidas fica no fim", () => {
	assert.deepEqual(decideLanding({ anchorId: null, allIds: all, visibleIds: visible, hasMoreHistory: true, olderLoads: 0 }), { kind: "bottom" });
});

test("pouso: com não lidas vai para a linha, mesmo com a âncora escondida", () => {
	assert.deepEqual(decideLanding({ anchorId: "c", allIds: all, visibleIds: visible, hasMoreHistory: false, olderLoads: 0 }), { kind: "divider", messageId: "c" });
	assert.deepEqual(decideLanding({ anchorId: "hidden", allIds: all, visibleIds: visible, hasMoreHistory: false, olderLoads: 0 }), { kind: "divider", messageId: "c" });
});

test("pouso: âncora antiga busca histórico, com limite", () => {
	assert.deepEqual(decideLanding({ anchorId: "old", allIds: all, visibleIds: visible, hasMoreHistory: true, olderLoads: 0 }), { kind: "load-older" });
	assert.deepEqual(decideLanding({ anchorId: "old", allIds: all, visibleIds: visible, hasMoreHistory: true, olderLoads: MAX_OLDER_LOADS_FOR_ANCHOR }), { kind: "bottom" });
	assert.deepEqual(decideLanding({ anchorId: "old", allIds: all, visibleIds: visible, hasMoreHistory: false, olderLoads: 0 }), { kind: "bottom" });
});

test("pouso: só escondidas depois da âncora cai no fim", () => {
	assert.deepEqual(decideLanding({ anchorId: "x", allIds: ["a", "x"], visibleIds: ["a"], hasMoreHistory: false, olderLoads: 0 }), { kind: "bottom" });
});

test("scrollTop do pouso", () => {
	assert.equal(landingScrollTop({ target: "bottom", scrollHeight: 2000, clientHeight: 700 }), 1300);
	assert.equal(landingScrollTop({ target: "bottom", scrollHeight: 500, clientHeight: 700 }), 0);
	assert.equal(landingScrollTop({ target: "divider", scrollHeight: 2000, clientHeight: 700, dividerTop: 900 }), 900 - DIVIDER_HEADROOM_PX);
	assert.equal(landingScrollTop({ target: "divider", scrollHeight: 2000, clientHeight: 700, dividerTop: 1950 }), 1300);
	assert.equal(landingScrollTop({ target: "divider", scrollHeight: 2000, clientHeight: 700, dividerTop: 10 }), 0);
});

test("re-ancora só enquanto assenta e sem toque do usuário", () => {
	assert.equal(shouldReanchor({ elapsedMs: 300, userInteracted: false }), true);
	assert.equal(shouldReanchor({ elapsedMs: 300, userInteracted: true }), false);
	assert.equal(shouldReanchor({ elapsedMs: LANDING_LOCK_MS + 1, userInteracted: false }), false);
});

test("grudado no fim segue; quem subiu recebe a pílula", () => {
	assert.equal(isPinned(0), true);
	assert.equal(isPinned(119), true);
	assert.equal(isPinned(400), false);
	assert.equal(decideArrival({ newMessages: 2, pinned: true }), "follow");
	assert.equal(decideArrival({ newMessages: 2, pinned: false }), "pill");
	assert.equal(decideArrival({ newMessages: 0, pinned: false }), "none");
});

test("voltou de segundo plano: primeira do assistente depois da última vista", () => {
	const messages = [{ id: "u", kind: "user" }, { id: "a1", kind: "assistant" }, { id: "u2", kind: "user" }, { id: "a2", kind: "assistant" }];
	assert.equal(resumeAnchorId(messages, "a1"), "a2");
	assert.equal(resumeAnchorId(messages, "a2"), null);
	assert.equal(resumeAnchorId(messages, "sumiu"), null);
	assert.equal(resumeAnchorId(messages, null), "a1");
});
