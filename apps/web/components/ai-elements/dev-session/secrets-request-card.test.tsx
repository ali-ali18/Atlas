import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SecretsRequestCard } from "./secrets-request-card";

Object.assign(globalThis, { React });

const info = { environmentId: "e1", repo: "acme/site", names: ["DATABASE_URL", "STRIPE_KEY"], reason: "os testes abrem o banco" };

test("pedido de segredos: título, motivo e textarea com NOME= por linha (sem valores)", () => {
	const html = renderToStaticMarkup(<SecretsRequestCard description="os testes abrem o banco" info={info} title="Este projeto precisa de: DATABASE_URL, STRIPE_KEY" />);
	assert.match(html, /data-secrets-request/);
	assert.match(html, /Este projeto precisa de: DATABASE_URL, STRIPE_KEY/);
	assert.match(html, /os testes abrem o banco/);
	assert.match(html, /<textarea/);
	assert.match(html, /DATABASE_URL=/);
	assert.match(html, /STRIPE_KEY=/);
	assert.match(html, />Salvar</);
	assert.match(html, /Agora não/);
	assert.match(html, /o agente só vê os nomes salvos/);
});

test("pedido de segredos: erros por linha aparecem e depois de decidido só ficam os nomes", () => {
	const err = renderToStaticMarkup(<SecretsRequestCard info={info} initialErrors={["linha 2: STRIPE_KEY está sem valor"]} title="t" />);
	assert.match(err, /linha 2: STRIPE_KEY está sem valor/);
	const done = renderToStaticMarkup(<SecretsRequestCard info={info} status="approved" title="t" />);
	assert.doesNotMatch(done, /<textarea/);
	assert.match(done, /Salvo/);
});
