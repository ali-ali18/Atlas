import React from "react";
Object.assign(globalThis, { React });
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AvatarStatus, avatarDotMask, resolveAvatarStatus } from "./avatar-status";

test("precedência: trabalhando > não lida > estrela do principal", () => {
	assert.equal(resolveAvatarStatus({ working: true, unread: true, primary: true }), "working");
	assert.equal(resolveAvatarStatus({ unread: true, primary: true }), "unread");
	assert.equal(resolveAvatarStatus({ primary: true }), "primary");
	assert.equal(resolveAvatarStatus({}), "none");
});

const child = <i data-child />;

test("trabalhando: bolinha verde, recorte no avatar e sem estrela", () => {
	const html = renderToStaticMarkup(
		<AvatarStatus primary size={52} unread working>
			{child}
		</AvatarStatus>,
	);
	assert.match(html, /aria-label="Trabalhando"/);
	assert.match(html, /#22c55e/);
	assert.match(html, /mask-image/);
	assert.doesNotMatch(html, /Bot principal/);
});

test("não lida esconde a estrela do principal; ocioso mostra", () => {
	const unread = renderToStaticMarkup(
		<AvatarStatus primary size={52} unread>
			{child}
		</AvatarStatus>,
	);
	assert.match(unread, /aria-label="Não lida"/);
	assert.doesNotMatch(unread, /Bot principal/);
	const idle = renderToStaticMarkup(
		<AvatarStatus primary size={52}>
			{child}
		</AvatarStatus>,
	);
	assert.match(idle, /aria-label="Bot principal"/);
	assert.doesNotMatch(idle, /data-avatar-dot/);
});

test("sem estado: renderiza só o avatar", () => {
	assert.equal(renderToStaticMarkup(<AvatarStatus size={52}>{child}</AvatarStatus>), '<i data-child="true"></i>');
});

test("grupo: rótulo com prefixo; animação só com movimento permitido", () => {
	const html = renderToStaticMarkup(
		<AvatarStatus label="Grupo" size={52} unread>
			{child}
		</AvatarStatus>,
	);
	assert.match(html, /aria-label="Grupo: não lida"/);
	assert.match(html, /motion-safe:animate-in/);
	assert.doesNotMatch(html.replaceAll("motion-safe:animate-in", ""), /\banimate-in\b/);
});

test("recorte acompanha o tamanho da bolinha", () => {
	assert.notEqual(JSON.stringify(avatarDotMask(24)), JSON.stringify(avatarDotMask(72)));
});
