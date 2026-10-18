import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UserAvatar, avatarGradient, avatarInitial } from "@workspace/ui/components/gradient-avatar";

Object.assign(globalThis, { React });

test("mesmo id, mesmo gradiente (e-mail sem caixa/espaços)", () => {
	assert.deepEqual(avatarGradient("user-1"), avatarGradient("user-1"));
	assert.equal(avatarGradient(" Ana@X.com ").background, avatarGradient("ana@x.com").background);
});

test("ids diferentes dão gradientes diferentes", () => {
	const set = new Set(Array.from({ length: 40 }, (_, i) => avatarGradient(`user-${i}`).background));
	assert.equal(set.size, 40);
});

test("sem foto: mesh com a inicial escura; com foto: mostra a foto", () => {
	const none = renderToStaticMarkup(<UserAvatar name="ana" seed="a@b.c" size={64} />);
	assert.match(none, /data-gradient/);
	assert.match(none, /gradient\(/);
	assert.doesNotMatch(none, /<img/);
	assert.match(none, /conic-gradient/, "redemoinho cônico");
	assert.match(none, /filter:blur/, "camada desfocada, sem borrar a letra");
	assert.match(none, /color:rgb\(10 10 10/, "letra escura");
	assert.doesNotMatch(none, /text-shadow/);
	assert.match(none, />A</);
	assert.match(none, /font-size:27px/);
	assert.match(none, /width:64px/);
	const photo = renderToStaticMarkup(<UserAvatar image="data:image/webp;base64,AAAA" seed="a@b.c" />);
	assert.match(photo, /<img[^>]*src="data:image\/webp;base64,AAAA"/);
	assert.doesNotMatch(photo, /data-gradient/);
});

test("inicial: nome; sem nome, e-mail; sem nada, ?", () => {
	assert.equal(avatarInitial("ana", "x@y.z"), "A");
	assert.equal(avatarInitial("  ", "bia@y.z"), "B");
	assert.equal(avatarInitial(undefined, undefined), "?");
	assert.match(renderToStaticMarkup(<UserAvatar email="bia@y.z" name="" seed="bia@y.z" />), />B</);
});

test("sempre um lado profundo e um claro, com matizes distantes, e a letra cai na parte clara", () => {
	for (let i = 0; i < 300; i += 1) {
		const g = avatarGradient(`user-${i}@x.com`);
		const d = Math.abs(g.deepHue - g.lightHue);
		const dist = Math.min(d, 360 - d);
		assert.ok(dist >= 139 && dist <= 181, `distância de matiz ${dist}`);
		assert.ok(g.centerAngle >= 150 && g.centerAngle <= 210, `centro em ${g.centerAngle}deg, dentro da parte clara (125-260)`);
		assert.match(g.background, /^radial-gradient.*conic-gradient\(from \d+deg at /);
	}
});
