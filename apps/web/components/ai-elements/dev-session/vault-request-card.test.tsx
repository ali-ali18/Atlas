import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { VaultRequestCard } from "./vault-request-card";

Object.assign(globalThis, { React });

const info = { environmentId: "vault", repo: "", names: ["stripe-key", "openai"], reason: "Para cobrar o cliente" };

test("pedido ao cofre: um campo de senha por nome, sem valores e sem textarea", () => {
	const html = renderToStaticMarkup(<VaultRequestCard description="Para cobrar o cliente" info={info} title="O bot precisa de: stripe-key, openai" />);
	assert.match(html, /data-vault-request/);
	assert.match(html, /O bot precisa de: stripe-key, openai/);
	assert.equal((html.match(/type="password"/g) ?? []).length, 2);
	assert.doesNotMatch(html, /<textarea/);
	assert.match(html, /Salvar no cofre/);
	assert.match(html, /Agora não/);
	assert.match(html, /direto para o seu cofre/);
});

test("pedido ao cofre decidido mostra só os nomes", () => {
	const done = renderToStaticMarkup(<VaultRequestCard info={info} status="approved" title="t" />);
	assert.doesNotMatch(done, /type="password"/);
	assert.match(done, /Salvo no cofre/);
	assert.match(done, /Ver nomes/);
});
