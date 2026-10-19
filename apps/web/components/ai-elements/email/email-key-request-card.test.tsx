import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EmailKeyRequestCard } from "./email-key-request-card";

Object.assign(globalThis, { React });

test("pedido da chave: campo de senha, aviso de que o bot não vê e botões (sem nenhum valor na marcação)", () => {
	const html = renderToStaticMarkup(<EmailKeyRequestCard description="Cole a chave" title="Falta a chave do OpenMail" />);
	assert.match(html, /data-email-key-request/);
	assert.match(html, /type="password"/);
	assert.match(html, /autoComplete="new-password"/);
	assert.match(html, />Salvar chave</);
	assert.match(html, /Abrir Configurações/);
	assert.match(html, /Agora não/);
	assert.match(html, /O bot nunca vê a chave/);
	assert.match(html, /Precisa de você/);
});

test("depois de salvo o cartão só diz 'Chave salva' e some o campo", () => {
	const html = renderToStaticMarkup(<EmailKeyRequestCard status="approved" title="Falta a chave do OpenMail" />);
	assert.doesNotMatch(html, /type="password"/);
	assert.match(html, /Chave salva/);
});
