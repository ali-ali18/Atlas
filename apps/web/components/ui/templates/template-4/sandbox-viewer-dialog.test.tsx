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
} from "./sandbox-viewer-dialog";

const render = (onFinish?: () => void) =>
	renderToStaticMarkup(
		<SandboxViewerDialog
			botName="Atlas"
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

test("celular: voltar, bot, recarregar e Terminei no cabeçalho; colar e teclado flutuantes, sem zoom", () => {
	const html = render(() => undefined);
	assert.match(html, /aria-label="Abrir o teclado"/);
	assert.match(html, /aria-label="Colar texto na VM"/);
	assert.match(html, /aria-label="Recarregar tela do sandbox"/);
	assert.match(html, /h-dvh w-dvw/);
	assert.match(html, /aspect-video/);
	assert.match(html, /left-4/);
	assert.match(html, /right-4/);
	assert.doesNotMatch(html, /Ampliar a tela|Mover a tela|Zoom/);
	// "Terminei" fica antes da área da VM (iframe), não por cima dela.
	assert.ok(html.indexOf("Terminei") < html.indexOf("<iframe"));
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
