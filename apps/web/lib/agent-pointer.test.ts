import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { AgentPointerEvent } from "@workspace/shared";
import {
	containRect,
	labelAnchor,
	pointerToContainer,
	readableTextColor,
	reduceAgentPointer,
	scheduleIdleFade,
} from "./agent-pointer";

const event = (patch: Partial<AgentPointerEvent> = {}): AgentPointerEvent => ({
	type: "agent_pointer",
	action: "click",
	viewportW: 1280,
	viewportH: 800,
	label: "Clicando",
	at: 1,
	...patch,
});

test("containRect: tela mais larga que o container deixa faixas em cima e embaixo", () => {
	const rect = containRect({ width: 400, height: 400 }, { width: 1280, height: 800 });
	assert.deepEqual(rect, { left: 0, top: 75, width: 400, height: 250 });
});

test("containRect: tela mais alta que o container deixa faixas dos lados", () => {
	const rect = containRect({ width: 800, height: 400 }, { width: 400, height: 400 });
	assert.deepEqual(rect, { left: 200, top: 0, width: 400, height: 400 });
});

test("containRect: tamanhos inválidos não geram retângulo", () => {
	assert.equal(containRect({ width: 0, height: 100 }, { width: 10, height: 10 }), null);
	assert.equal(containRect({ width: 100, height: 100 }, { width: 0, height: 0 }), null);
});

test("pointerToContainer: escala x,y da tela real para o container com letterbox", () => {
	// 1280x800 dentro de 640x640 => imagem 640x400 com 120px de faixa em cima.
	const pos = pointerToContainer({ x: 640, y: 400 }, { width: 1280, height: 800 }, { width: 640, height: 640 });
	assert.deepEqual(pos, { left: 320, top: 320 });
	const corner = pointerToContainer({ x: 0, y: 0 }, { width: 1280, height: 800 }, { width: 640, height: 640 });
	assert.deepEqual(corner, { left: 0, top: 120 });
});

test("pointerToContainer: ponto fora da tela é preso à borda", () => {
	const pos = pointerToContainer({ x: 9999, y: -5 }, { width: 100, height: 100 }, { width: 200, height: 200 });
	assert.deepEqual(pos, { left: 200, top: 0 });
});

test("reduceAgentPointer: evento sem coordenadas mantém a última posição", () => {
	const first = reduceAgentPointer(null, event({ x: 10, y: 20 }));
	const typed = reduceAgentPointer(first, event({ action: "type", label: "Digitando…" }));
	assert.equal(typed.x, 10);
	assert.equal(typed.y, 20);
	assert.equal(typed.label, "Digitando…");
	assert.equal(typed.clickSeq, first.clickSeq);
	assert.equal(typed.seq, first.seq + 1);
});

test("reduceAgentPointer: tela diferente descarta a posição antiga", () => {
	const first = reduceAgentPointer(null, event({ x: 10, y: 20 }));
	const other = reduceAgentPointer(first, event({ action: "type", viewportW: 800 }));
	assert.equal(other.x, undefined);
});

test("reduceAgentPointer: só clique com coordenadas conta ondulação", () => {
	const first = reduceAgentPointer(null, event({ x: 1, y: 1 }));
	const second = reduceAgentPointer(first, event({ x: 2, y: 2 }));
	assert.equal(second.clickSeq, 2);
	assert.equal(reduceAgentPointer(null, event()).clickSeq, 0);
});

test("labelAnchor: perto das bordas o rótulo abre para dentro", () => {
	const box = { width: 100, height: 100 };
	assert.deepEqual(labelAnchor({ left: 10, top: 10 }, box), { horizontal: "right", vertical: "below" });
	assert.deepEqual(labelAnchor({ left: 90, top: 95 }, box), { horizontal: "left", vertical: "above" });
});

test("scheduleIdleFade: some depois de 3 s sem evento e reiniciar cancela o anterior", () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		let hidden = 0;
		const cancel = scheduleIdleFade(() => (hidden += 1));
		mock.timers.tick(2900);
		assert.equal(hidden, 0);
		cancel();
		scheduleIdleFade(() => (hidden += 1));
		mock.timers.tick(2999);
		assert.equal(hidden, 0);
		mock.timers.tick(1);
		assert.equal(hidden, 1);
	} finally {
		mock.timers.reset();
	}
});

test("readableTextColor: branco em fundo escuro, escuro em fundo claro", () => {
	assert.equal(readableTextColor("#212121"), "#ffffff");
	assert.equal(readableTextColor("#1d4ed8"), "#ffffff");
	assert.equal(readableTextColor("#f44336"), "#ffffff");
	assert.equal(readableTextColor("#ffeb3b"), "#111111");
	assert.equal(readableTextColor("#ffffff"), "#111111");
	assert.equal(readableTextColor("#000"), "#ffffff");
});

test("readableTextColor: aceita #rgb sem hash e cai no branco se inválida", () => {
	assert.equal(readableTextColor("fff"), "#111111");
	assert.equal(readableTextColor("azul"), "#ffffff");
	assert.equal(readableTextColor(""), "#ffffff");
});
