import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { detectSecretsInText, replaceDetected } from "@workspace/shared";
import { SecretPasteNotice } from "./secret-paste-notice";
import { nameDetected } from "./use-secret-paste-guard";

Object.assign(globalThis, { React });

test("aviso: texto, botões e destaque quando o envio foi barrado", () => {
	const html = renderToStaticMarkup(<SecretPasteNotice count={1} onSave={() => {}} onSendAnyway={() => {}} />);
	assert.match(html, /data-secret-paste-notice/);
	assert.match(html, /Isso parece uma senha\/chave/);
	assert.match(html, /Guardar no cofre/);
	assert.match(html, /Enviar mesmo assim/);
	assert.match(renderToStaticMarkup(<SecretPasteNotice attention count={2} error="falhou" onSave={() => {}} onSendAnyway={() => {}} />), /senhas\/chaves.*falhou/s);
});

test("guardar no cofre troca o valor pelo marcador e nomes não colidem na mesma mensagem", () => {
	const text = "n8n em https://x.com/v1/hooks/k1?secret=Zk3jQ9sLpW2mXv e outra https://y.com/h?secret=Pq8rT2vN5bC7dE";
	const detected = detectSecretsInText(text);
	assert.equal(detected.length, 2);
	const names = nameDetected(detected);
	assert.deepEqual(names, ["webhook-secret", "webhook-secret-2"]);
	const out = replaceDetected(text, detected, names);
	assert.equal(out, "n8n em https://x.com/v1/hooks/k1?secret={{secret:webhook-secret}} e outra https://y.com/h?secret={{secret:webhook-secret-2}}");
	assert.doesNotMatch(out, /Zk3jQ9sLpW2mXv|Pq8rT2vN5bC7dE/);
});

test("textos comuns não disparam o aviso", () => {
	for (const text of ["Oi, pode resumir meu e-mail?", "Abra https://github.com/org/repo/pull/12 e revise", "use {{secret:meu-token}} no header", "Meu CPF é 123.456.789-09 e o pedido 20261015abc"]) {
		assert.equal(detectSecretsInText(text).length, 0, text);
	}
});
