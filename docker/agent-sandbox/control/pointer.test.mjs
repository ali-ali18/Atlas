import { test } from "node:test";
import assert from "node:assert/strict";
import { readPointer, safePointer } from "./pointer.mjs";

function fakeEl({ rect = { left: 100, top: 50, width: 80, height: 20 }, attrs = {}, type = "", tag = "BUTTON", text = "", labels, value } = {}) {
	const view = {
		frameElement: null,
		outerWidth: 1280, innerWidth: 1280, outerHeight: 800, innerHeight: 750,
		screenX: 0, screenY: 0, screen: { width: 1280, height: 800 },
	};
	return {
		ownerDocument: { defaultView: view },
		getBoundingClientRect: () => rect,
		getAttribute: (key) => attrs[key] ?? null,
		type, tagName: tag, innerText: text, labels, value,
	};
}

test("readPointer: centro do elemento na tela, com o deslocamento da barra do navegador", () => {
	const p = readPointer(fakeEl({ text: "Semana 1" }));
	assert.equal(p.x, 140);
	assert.equal(p.y, 60 + 50);
	assert.equal(p.name, "Semana 1");
	assert.equal(p.screenW, 1280);
});

test("readPointer: nome longo é truncado em 40 caracteres", () => {
	const p = readPointer(fakeEl({ text: "a".repeat(100) }));
	assert.equal(p.name.length, 40);
	assert.ok(p.name.endsWith("…"));
});

test("readPointer: campo de senha não expõe nome", () => {
	const p = readPointer(fakeEl({ tag: "INPUT", type: "password", attrs: { "aria-label": "Senha do banco" } }));
	assert.equal(p.name, undefined);
	assert.equal(p.sensitive, true);
});

test("readPointer: elemento sem área não gera ponto", () => {
	assert.equal(readPointer(fakeEl({ rect: { left: 0, top: 0, width: 0, height: 0 } })), null);
});

test("safePointer: falha ao medir devolve undefined em vez de lançar", async () => {
	assert.equal(await safePointer(() => ({ evaluate: async () => { throw new Error("detached"); } })), undefined);
	assert.equal(await safePointer(() => { throw new Error("sem locator"); }), undefined);
});
