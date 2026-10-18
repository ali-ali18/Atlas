import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { appViewport } from "./viewport-config";

test("viewport: teclado redimensiona o conteúdo e o app usa a tela toda", () => {
	assert.equal(appViewport.interactiveWidget, "resizes-content");
	assert.equal(appViewport.viewportFit, "cover");
});

test("layout raiz usa o viewport do app e declara pt-BR", () => {
	const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
	assert.match(layout, /export const viewport: Viewport = appViewport/);
	assert.match(layout, /<html lang="pt-BR"/);
});
