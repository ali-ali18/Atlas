import React from "react";
Object.assign(globalThis, { React });
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	focusNoVncKeyboard,
	SandboxViewerDialog,
	viewerSessionId,
	viewerUrlIdentity,
} from "./sandbox-viewer-dialog";

const render = (onFinish?: () => void, desktop = false) =>
	renderToStaticMarkup(
		<SandboxViewerDialog
			botName="Atlas"
			desktop={desktop}
			onClose={() => undefined}
			onFinish={onFinish}
			onReload={() => undefined}
			reloadKey={0}
			viewerUrl="http://localhost:6080/vnc.html"
		/>,
	);

test("a VM abre num diálogo da própria página, com a tela ao vivo e fechar", () => {
	const html = render();
	assert.match(html, /role="dialog"/);
	assert.match(html, /aria-modal="true"/);
	assert.match(html, /<iframe[^>]*src="http:\/\/localhost:6080\/vnc\.html"/);
	assert.match(html, /aria-label="Fechar tela do sandbox"/);
	assert.doesNotMatch(html, /Terminei/);
});

test("aberta por um card de login, 'Terminei' fica na mesma tela", () => {
	assert.match(render(() => undefined), />Terminei<\/button>/);
});

test("o card de login não abre a VM em aba nova", () => {
	for (const file of ["chat-thread/chat-thread.tsx", "chat-thread/message-row.tsx"]) {
		const source = readFileSync(new URL(file, import.meta.url), "utf8");
		assert.doesNotMatch(source, /window\.open\(/, file);
	}
});

test("o cursor do agente aparece sobre a tela ao vivo, sem capturar cliques", () => {
	const html = renderToStaticMarkup(
		<SandboxViewerDialog
			agentPointer={{
				action: "click",
				label: "Clicando em “Semana 1”",
				at: 1,
				x: 10,
				y: 10,
				viewportW: 1280,
				viewportH: 800,
				clickSeq: 1,
				seq: 1,
			}}
			botName="Atlas"
			onClose={() => undefined}
			onReload={() => undefined}
			reloadKey={0}
			viewerUrl="http://localhost:6080/vnc.html"
		/>,
	);
	assert.match(html, /Clicando em “Semana 1”/);
	assert.match(html, /pointer-events-none absolute inset-0/);
});

test("sem barra preta: só botões sobrepostos nos cantos, que não cobrem a VM", () => {
	for (const html of [render(() => undefined, false), render(() => undefined, true)]) {
		assert.doesNotMatch(html, /h-14|bg-zinc-950 px-2|shrink-0 items-center gap-2 bg-black/);
		assert.match(html, /aria-label="Recarregar tela do sandbox"/);
		assert.match(html, /absolute z-10[^"]*left-2/);
		assert.match(html, /absolute z-10[^"]*right-2/);
		assert.match(html, /bg-black\/40/);
		// Terminei continua disponível, sobreposto.
		assert.match(html, />Terminei<\/button>/);
	}
});

test("teclado e colar existem só no celular", () => {
	const mobile = render(undefined, false);
	assert.match(mobile, /aria-label="Abrir o teclado"/);
	assert.match(mobile, /aria-label="Colar texto na VM"/);
	assert.match(mobile, /h-dvh w-dvw/);
	assert.match(mobile, /aspect-video/);
	assert.doesNotMatch(mobile, /Ampliar a tela|Mover a tela|Zoom/);
	const desktop = render(undefined, true);
	assert.doesNotMatch(desktop, /aria-label="Abrir o teclado"/);
	assert.doesNotMatch(desktop, /aria-label="Colar texto na VM"/);
});

test("viewerUrlIdentity ignora o token efêmero (evita recarregar o iframe a cada poll)", () => {
	const base = "/v1/sandbox/sessions/s1/viewer/vnc.html?autoconnect=1&reconnect=true&resize=scale&path=";
	const url = (token: string) =>
		base + encodeURIComponent(`/v1/sandbox/sessions/s1/viewer/websockify?t=${token}`);
	assert.notEqual(url("aaa.bbb"), url("ccc.ddd"));
	assert.equal(viewerUrlIdentity(url("aaa.bbb")), viewerUrlIdentity(url("ccc.ddd")));
	const other = url("x.y").replace("/s1/", "/s2/");
	assert.notEqual(viewerUrlIdentity(url("aaa.bbb")), viewerUrlIdentity(other));
	assert.equal(viewerUrlIdentity("http://localhost:6080/vnc.html?a=1"), "/vnc.html?a=1");
});

test("viewerSessionId lê o id da sessão da URL em modo proxy", () => {
	assert.equal(
		viewerSessionId("/v1/sandbox/sessions/abc-123/viewer/vnc.html?autoconnect=1"),
		"abc-123",
	);
	assert.equal(viewerSessionId("http://localhost:6080/vnc.html"), null);
});

test("focusNoVncKeyboard foca o campo do noVNC e cai para false sem acesso", () => {
	let focused = false;
	const same = {
		contentDocument: {
			getElementById: (id: string) =>
				id === "noVNC_keyboardinput" ? { focus: () => (focused = true) } : null,
		},
	} as unknown as HTMLIFrameElement;
	assert.equal(focusNoVncKeyboard(same), true);
	assert.equal(focused, true);
	const crossOrigin = {
		get contentDocument(): never {
			throw new Error("SecurityError");
		},
	} as unknown as HTMLIFrameElement;
	assert.equal(focusNoVncKeyboard(crossOrigin), false);
	assert.equal(focusNoVncKeyboard(null), false);
});
