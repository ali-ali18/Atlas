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

const loginInfo = {
	environmentId: "vault",
	repo: "",
	names: ["nome", "cpf", "senha"],
	reason: "Entrar na plataforma",
	login: { site: "plataforma.example", fields: [{ key: "nome", label: "Nome", secret: false }, { key: "cpf", label: "CPF", secret: true }, { key: "senha", label: "Senha", secret: true }] },
};

test("pedido de login: um campo por item declarado, com o rótulo; secreto em campo de senha, o resto em texto; sem valor nem textarea", () => {
	const html = renderToStaticMarkup(<VaultRequestCard description="Entrar na plataforma" info={loginInfo} title="O bot precisa do seu login de plataforma.example" />);
	assert.match(html, /data-vault-request/);
	assert.equal((html.match(/<input/g) ?? []).length, 3);
	assert.equal((html.match(/type="password"/g) ?? []).length, 2);
	assert.equal((html.match(/type="text"/g) ?? []).length, 1);
	for (const label of ["Nome", "CPF", "Senha"]) assert.match(html, new RegExp(`>${label}<`));
	assert.doesNotMatch(html, /<textarea/);
	assert.match(html, /mesmo login deste site/);
	assert.match(html, /Salvar no cofre/);
});

test("pedido de login decidido não mostra campo nenhum (os rótulos ficam recolhidos)", () => {
	const done = renderToStaticMarkup(<VaultRequestCard info={loginInfo} status="approved" title="t" />);
	assert.doesNotMatch(done, /<input/);
	assert.match(done, /Ver nomes/);
});
