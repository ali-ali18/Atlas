import React from "react";
Object.assign(globalThis, { React });
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentPointerState } from "@/lib/agent-pointer";
import { AgentPointerLayer, AgentPointerOverlay } from "./agent-pointer-overlay";

const pointer = (patch: Partial<AgentPointerState> = {}): AgentPointerState => ({
	action: "click",
	label: "Clicando em “Semana 1”",
	at: 1,
	x: 640,
	y: 400,
	viewportW: 1280,
	viewportH: 800,
	clickSeq: 1,
	seq: 1,
	...patch,
});

const render = (state: AgentPointerState, visible = true) =>
	renderToStaticMarkup(
		<AgentPointerLayer
			botName="Bob"
			color="#1d4ed8"
			container={{ width: 640, height: 640 }}
			pointer={state}
			visible={visible}
		/>,
	);

test("o cursor aparece na posição escalada com letterbox, com rótulo e ondulação", () => {
	const html = render(pointer());
	assert.match(html, /data-agent-cursor=""[^>]*style="left:320px;top:320px"/);
	assert.match(html, /Clicando em “Semana 1”/);
	assert.match(html, /data-agent-ripple/);
	assert.match(html, /transition-\[left,top\] duration-300/);
});

test("respeita prefers-reduced-motion: sem deslizar nem ondular", () => {
	const html = render(pointer());
	assert.match(html, /motion-reduce:transition-none/);
	assert.match(html, /motion-reduce:animate-none/);
});

test("sem clique não há ondulação; sem coordenadas o rótulo fica na base da tela", () => {
	assert.doesNotMatch(render(pointer({ action: "move", clickSeq: 0 })), /data-agent-ripple/);
	const html = render(pointer({ x: undefined, y: undefined, action: "scroll", label: "Rolando a página" }));
	assert.doesNotMatch(html, /data-agent-cursor/);
	assert.match(html, /bottom-2[^>]*data-agent-label/);
	assert.match(html, />Rolando a página</);
});

test("inativo: a camada fica transparente (fade)", () => {
	assert.match(render(pointer(), false), /opacity-0/);
	assert.match(render(pointer(), true), /opacity-100/);
});

test("sem evento nada é desenhado dentro do overlay", () => {
	const html = renderToStaticMarkup(<AgentPointerOverlay pointer={null} />);
	assert.doesNotMatch(html, /data-agent/);
});

test("a etiqueta mostra o nome do bot e a ação, na cor do bot com texto legível", () => {
	const html = render(pointer());
	assert.match(html, /data-agent-label=""[^>]*style="background-color:#1d4ed8;color:#ffffff"/);
	assert.match(html, />Bob<\/span>/);
	assert.match(html, />Clicando em “Semana 1”<\/span>/);
	assert.match(html, /fill:#1d4ed8/);
	assert.match(html, /data-agent-ripple[^>]*border-color:#1d4ed8/);
});

test("cor clara usa texto escuro na etiqueta", () => {
	const html = renderToStaticMarkup(
		<AgentPointerLayer
			botName="Bob"
			color="#ffeb3b"
			container={{ width: 640, height: 640 }}
			pointer={pointer()}
			visible
		/>,
	);
	assert.match(html, /background-color:#ffeb3b;color:#111111/);
});
