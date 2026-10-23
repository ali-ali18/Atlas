import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AT_END_PX, FOLLOW_RESUME_PX, keyReleasesFollow, stickAfterScroll, touchReleasesFollow, wheelReleasesFollow } from "./follow-bottom";

describe("stickAfterScroll", () => {
	it("subir pouco (dentro de 120px) já solta o acompanhamento", () => {
		assert.equal(stickAfterScroll({ stuck: true, previousTop: 1000, top: 960, distance: 40 }), false);
		assert.equal(stickAfterScroll({ stuck: true, previousTop: 1000, top: 990, distance: 10 }), false);
	});
	it("não volta sozinho enquanto sobe, mesmo perto do fim", () => {
		assert.equal(stickAfterScroll({ stuck: false, previousTop: 990, top: 980, distance: 20 }), false);
	});
	it("conteúdo que cresce (sem rolagem) não solta quem está acompanhando", () => {
		assert.equal(stickAfterScroll({ stuck: true, previousTop: 1000, top: 1000, distance: 300 }), true);
	});
	it("quem soltou fica solto enquanto longe do fim", () => {
		assert.equal(stickAfterScroll({ stuck: false, previousTop: 500, top: 520, distance: 400 }), false);
	});
	it("rolando para baixo até perto do fim volta a acompanhar", () => {
		assert.equal(stickAfterScroll({ stuck: false, previousTop: 800, top: 900, distance: FOLLOW_RESUME_PX }), true);
		assert.equal(stickAfterScroll({ stuck: false, previousTop: 800, top: 900, distance: FOLLOW_RESUME_PX + 1 }), false);
	});
	it("navegador prende o scrollTop no fim (conteúdo encolheu): continua acompanhando", () => {
		assert.equal(stickAfterScroll({ stuck: true, previousTop: 1200, top: 1100, distance: 0 }), true);
		assert.equal(stickAfterScroll({ stuck: false, previousTop: 1200, top: 1100, distance: AT_END_PX }), true);
	});
});

describe("intenção de subir", () => {
	it("roda", () => {
		assert.equal(wheelReleasesFollow(-1), true);
		assert.equal(wheelReleasesFollow(0), false);
		assert.equal(wheelReleasesFollow(120), false);
	});
	it("dedo", () => {
		assert.equal(touchReleasesFollow(300, 320), true);
		assert.equal(touchReleasesFollow(300, 280), false);
		assert.equal(touchReleasesFollow(300, 300), false);
	});
	it("teclas", () => {
		for (const key of ["PageUp", "ArrowUp", "Home"]) assert.equal(keyReleasesFollow(key), true);
		for (const key of ["PageDown", "ArrowDown", "End", "a", " "]) assert.equal(keyReleasesFollow(key), false);
	});
});
