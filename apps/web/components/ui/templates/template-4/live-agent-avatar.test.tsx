import React from "react";
Object.assign(globalThis, { React });
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentAvatar } from "./agent-avatar";
import { LiveAgentAvatar } from "./live-agent-avatar";
import { AvatarStatus } from "./avatar-status";

test("usa olhos claros em corpo escuro e decora o SVG", () => {
	const html = renderToStaticMarkup(
		<LiveAgentAvatar bodyColor="#212121" botId="b1" reducedMotion />,
	);
	assert.match(html, /aria-hidden="true"/);
	assert.match(html, /fill="#f9f9f9"/);
});

test("visual chapado: sem gradiente, brilho nem sombra; olhos recortados por máscara", () => {
	const html = renderToStaticMarkup(
		<LiveAgentAvatar bodyColor="#FF6700" botId="b1" reducedMotion />,
	);
	assert.doesNotMatch(html, /gradient|<ellipse|<circle|filter/);
	assert.match(html, /<mask id="av-[\w-]+-holes"/);
	assert.equal(html.match(/<path /g)?.length, 2);
});

test("cor do corpo e forma vêm das props do bot (formas antigas continuam valendo)", () => {
	const a = renderToStaticMarkup(
		<LiveAgentAvatar bodyColor="#f44336" botId="b1" reducedMotion shape="goutte" />,
	);
	assert.match(a, /fill="#f44336"/);
	const b = renderToStaticMarkup(
		<LiveAgentAvatar bodyColor="#f44336" botId="b1" reducedMotion shape="rond" />,
	);
	assert.notEqual(a, b);
	const novo = renderToStaticMarkup(
		<LiveAgentAvatar bodyColor="#f44336" botId="b1" reducedMotion shape="teardrop" />,
	);
	assert.equal(a, novo);
});

test("bot sem forma/cor escolhidas: o id decide, sempre o mesmo", () => {
	const x = renderToStaticMarkup(<LiveAgentAvatar botId="bot-sem-config" reducedMotion />);
	const y = renderToStaticMarkup(<LiveAgentAvatar botId="bot-sem-config" reducedMotion />);
	assert.equal(x, y);
});

test("painel: botão interativo com aria-label do bot", () => {
	const html = renderToStaticMarkup(
		<LiveAgentAvatar ariaLabel="Cutucar Atlas" botId="b1" breathe follow="always" interactive size={112} />,
	);
	assert.match(html, /^<button/);
	assert.match(html, /aria-label="Cutucar Atlas"/);
	assert.match(html, /height:112px/);
});

test("avatar com notificação mantém o avatar vivo e só sobrepõe a bolinha", () => {
	const live = renderToStaticMarkup(
		<AvatarStatus size={52} unread>
			<LiveAgentAvatar bodyColor="#4caf50" botId="b1" reducedMotion />
		</AvatarStatus>,
	);
	assert.match(live, /fill="#4caf50"/);
	assert.match(live, /aria-label="Não lida"/);
});

test("AgentAvatar traduz o rosto pedido por nome para a expressão do motor", () => {
	const feliz = renderToStaticMarkup(<AgentAvatar bodyColor="#4caf50" mood="heureux" reducedMotion />);
	const neutro = renderToStaticMarkup(<AgentAvatar bodyColor="#4caf50" mood="neutre" reducedMotion />);
	assert.notEqual(feliz, neutro);
});

// REGRESSÃO: o chat usava o avatar estático (AgentAvatar sem follow/breathe/
// pokeOnClick) e, no cabeçalho, só olhava no hover. Estas telas têm de usar o
// avatar vivo e ligar respiração, olhar e cutucada.
test("chat: cabeçalho e indicador de trabalho usam o avatar vivo e interativo", async () => {
	const { readFile } = await import("node:fs/promises");
	for (const file of ["chat-thread/chat-thread.tsx", "chat-thread/working-indicator.tsx"]) {
		const src = await readFile(new URL(file, import.meta.url), "utf8");
		const tag = src.match(/<LiveAgentAvatar[\s\S]*?\/>/g)?.at(-1) ?? "";
		assert.match(tag, /breathe/, file);
		assert.match(tag, /follow="always"/, file);
		assert.match(tag, /pokeOnClick/, file);
	}
	const indicator = await readFile(new URL("chat-thread/working-indicator.tsx", import.meta.url), "utf8");
	assert.doesNotMatch(indicator, /<AgentAvatar/);
	// o contêiner do indicador é pointer-events-none: o avatar precisa reativar
	assert.match(indicator, /<LiveAgentAvatar[\s\S]*?pointer-events-auto/);
});
