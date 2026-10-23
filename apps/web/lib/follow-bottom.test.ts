import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	AT_END_PX,
	FOLLOW_RESUME_PX,
	INTENT_WINDOW_MS,
	insideNestedScrollerThatCanScrollUp,
	keyIsUpward,
	stickAfterScroll,
	touchIsUpward,
	wheelIsUpward,
} from "./follow-bottom";

const base = { stuck: true, previousTop: 1000, top: 1000, distance: 0, now: 10_000, lastIntentAt: 0 };

describe("stickAfterScroll", () => {
	it("subiu de verdade logo depois de um gesto: solta, mesmo perto do fim", () => {
		assert.equal(stickAfterScroll({ ...base, top: 960, distance: 40, lastIntentAt: 9_900 }), false);
		assert.equal(stickAfterScroll({ ...base, top: 990, distance: 10, lastIntentAt: 9_900 }), false);
	});
	it("recuo sem gesto recente (ancoragem, inércia) não solta", () => {
		assert.equal(stickAfterScroll({ ...base, top: 960, distance: 40, lastIntentAt: 10_000 - INTENT_WINDOW_MS - 1 }), true);
		assert.equal(stickAfterScroll({ ...base, top: 960, distance: 40 }), true);
	});
	it("recuo de 1px não solta, 2px solta", () => {
		assert.equal(stickAfterScroll({ ...base, top: 999, distance: 20, lastIntentAt: 9_950 }), true);
		assert.equal(stickAfterScroll({ ...base, top: 998, distance: 20, lastIntentAt: 9_950 }), false);
	});
	it("gesto sem rolagem (conversa curta, scrollTop 0) não solta: nenhum evento de scroll chega", () => {
		// sem scroll não há chamada; o conteúdo que cresce depois não solta quem acompanha
		assert.equal(stickAfterScroll({ ...base, previousTop: 0, top: 0, distance: 600, lastIntentAt: 9_900 }), true);
	});
	it("quem soltou não volta sozinho enquanto sobe", () => {
		assert.equal(stickAfterScroll({ ...base, stuck: false, top: 980, previousTop: 990, distance: 20, lastIntentAt: 9_900 }), false);
		assert.equal(stickAfterScroll({ ...base, stuck: false, top: 980, previousTop: 990, distance: 20 }), false);
	});
	it("quem soltou fica solto longe do fim e volta ao rolar até perto dele", () => {
		assert.equal(stickAfterScroll({ ...base, stuck: false, previousTop: 500, top: 520, distance: 400 }), false);
		assert.equal(stickAfterScroll({ ...base, stuck: false, previousTop: 800, top: 900, distance: FOLLOW_RESUME_PX }), true);
		assert.equal(stickAfterScroll({ ...base, stuck: false, previousTop: 800, top: 900, distance: FOLLOW_RESUME_PX + 1 }), false);
	});
	it("conteúdo que cresce (sem rolagem) não solta quem acompanha", () => {
		assert.equal(stickAfterScroll({ ...base, distance: 300 }), true);
	});
	it("navegador prende o scrollTop no fim: continua acompanhando, com gesto ou sem", () => {
		assert.equal(stickAfterScroll({ ...base, previousTop: 1200, top: 1100, distance: 0, lastIntentAt: 9_900 }), true);
		assert.equal(stickAfterScroll({ ...base, stuck: false, previousTop: 1200, top: 1100, distance: AT_END_PX }), true);
	});
});

describe("intenção de subir", () => {
	it("roda: só para cima e mais vertical que horizontal", () => {
		assert.equal(wheelIsUpward(-1, 0), true);
		assert.equal(wheelIsUpward(0, 0), false);
		assert.equal(wheelIsUpward(120, 0), false);
		assert.equal(wheelIsUpward(-10, 40), false);
	});
	it("dedo: para baixo e mais vertical que horizontal", () => {
		assert.equal(touchIsUpward(0, 20), true);
		assert.equal(touchIsUpward(5, 20), true);
		assert.equal(touchIsUpward(30, 20), false);
		assert.equal(touchIsUpward(0, -20), false);
		assert.equal(touchIsUpward(0, 0), false);
	});
	it("teclas", () => {
		for (const key of ["PageUp", "ArrowUp", "Home"]) assert.equal(keyIsUpward(key), true);
		for (const key of ["PageDown", "ArrowDown", "End", "a", " "]) assert.equal(keyIsUpward(key), false);
	});
});

describe("insideNestedScrollerThatCanScrollUp", () => {
	// Nós mínimos: o guard usa `instanceof Element`, então simulamos com uma classe global.
	class FakeElement {
		constructor(
			public overflow: string,
			public scrollTop: number,
			public parentElement: FakeElement | null,
		) {}
	}
	(globalThis as unknown as { Element: unknown }).Element = FakeElement;
	const overflowY = (element: unknown) => (element as FakeElement).overflow;
	const root = new FakeElement("auto", 500, null);
	const as = (node: FakeElement) => node as unknown as Element;

	it("bloco de código que ainda pode subir: ignora o gesto", () => {
		const code = new FakeElement("auto", 40, root);
		const span = new FakeElement("visible", 0, code);
		assert.equal(insideNestedScrollerThatCanScrollUp(span as never, as(root), overflowY), true);
	});
	it("bloco já no topo, ou sem rolagem própria: a conversa é que rola", () => {
		const atTop = new FakeElement("auto", 0, root);
		assert.equal(insideNestedScrollerThatCanScrollUp(atTop as never, as(root), overflowY), false);
		const plain = new FakeElement("visible", 30, root);
		assert.equal(insideNestedScrollerThatCanScrollUp(plain as never, as(root), overflowY), false);
	});
	it("a própria conversa não conta como bloco aninhado", () => {
		assert.equal(insideNestedScrollerThatCanScrollUp(root as never, as(root), overflowY), false);
		assert.equal(insideNestedScrollerThatCanScrollUp(null, as(root), overflowY), false);
	});
});
