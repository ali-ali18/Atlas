import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NotificationsSettingsView } from "./notifications";

Object.assign(globalThis, { React });

const noop = () => {};
const now = Date.parse("2026-11-01T12:00:00Z");
const devices = [
	{ id: "d1", label: "Chrome · Android", createdAt: "2026-10-30T12:00:00Z", lastUsedAt: "2026-11-01T11:00:00Z", failing: false },
	{ id: "d2", label: "Safari · iOS", createdAt: "2026-10-30T12:00:00Z", lastUsedAt: "2026-10-30T12:00:00Z", failing: true },
];
const render = (props: Partial<React.ComponentProps<typeof NotificationsSettingsView>> = {}) =>
	renderToStaticMarkup(
		<NotificationsSettingsView
			currentDeviceId={null}
			devices={[]}
			now={now}
			onDisable={noop}
			onEnable={noop}
			onRemove={noop}
			onTest={noop}
			state="off"
			{...props}
		/>,
	);

test("desligado: botão Ativar, sem Testar e sem aparelhos", () => {
	const html = render();
	assert.match(html, /Notificações no celular/);
	assert.match(html, />Ativar</);
	assert.doesNotMatch(html, />Testar</);
	assert.match(html, /Nenhum aparelho ativado ainda/);
});

test("ligado: Desativar, Testar e a lista de aparelhos com remover", () => {
	const html = render({ state: "on", devices, currentDeviceId: "d1" });
	assert.match(html, />Desativar</);
	assert.match(html, />Testar</);
	assert.match(html, /Chrome · Android/);
	assert.match(html, /Este aparelho · há 1 h/);
	assert.match(html, /Safari · iOS/);
	assert.match(html, /com falhas/);
	assert.match(html, /aria-label="Remover Chrome · Android"/);
});

test("bloqueado (iPhone sem instalar, negado, sem servidor): botão desabilitado e explicação", () => {
	for (const state of ["needs-install", "denied", "server-off", "unsupported"] as const) {
		const html = render({ state });
		assert.match(html, /<button[^>]*disabled[^>]*>[^<]*Ativar/, state);
	}
	assert.match(render({ state: "needs-install" }), /Tela de Início/);
	assert.match(render({ state: "denied" }), /bloqueadas/);
});

test("erro e aviso aparecem; o texto nunca cita o nome do produto", () => {
	assert.match(render({ error: "Permissão negada." }), /role="alert"[^>]*>Permissão negada\./);
	assert.match(render({ notice: "Aparelho removido." }), /role="status"[^>]*>Aparelho removido\./);
	assert.doesNotMatch(render({ state: "on", devices }), /Atlas/);
});

test("busca: itens ocultos não aparecem", () => {
	const html = render({ state: "on", devices, isVisible: (id) => id === "notificacoes.aparelhos" });
	assert.doesNotMatch(html, />Desativar</);
	assert.match(html, /Chrome · Android/);
});
