import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AllowedSendersManager } from "./allowed-senders-page";
import { SenderPreviewList } from "./bot-email-tab";
import { buildSendersSearch, parseSendersLocation } from "@/lib/email-senders-url";

Object.assign(globalThis, { React });

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const noop = async () => true;
const many = Array.from({ length: 12 }, (_, i) => `pessoa${i}@empresa.com`);

test("aba: só o primeiro remetente aparece, com '+N remetentes' recolhido", () => {
	const out = html(<SenderPreviewList busy={false} onChange={noop} onOpenAll={() => {}} senders={many} />);
	assert.match(out, /data-allowed-sender="pessoa0@empresa.com"/);
	assert.equal((out.match(/data-allowed-sender=/g) ?? []).length, 1);
	assert.match(out, /\+11 remetentes/);
	assert.match(out, /aria-expanded="false"/);
	assert.doesNotMatch(out, /Ver todos/);
});

test("aba expandida: 4 mais recentes (fim da lista) e 'Ver todos'", () => {
	const out = html(<SenderPreviewList busy={false} defaultOpen onChange={noop} onOpenAll={() => {}} senders={many} />);
	assert.equal((out.match(/data-allowed-sender=/g) ?? []).length, 5);
	for (const id of [11, 10, 9, 8]) assert.match(out, new RegExp(`data-allowed-sender="pessoa${id}@empresa.com"`));
	assert.doesNotMatch(out, /data-allowed-sender="pessoa1@empresa.com"/);
	assert.match(out, /Ver todos/);
});

test("aba: com um único remetente não há gatilho de expandir", () => {
	const out = html(<SenderPreviewList busy={false} onChange={noop} onOpenAll={() => {}} senders={["a@x.co"]} />);
	assert.doesNotMatch(out, /allowed-more/);
});

test("página: lista completa com contagem, busca, remover e adicionar", () => {
	const out = html(<AllowedSendersManager busy={false} onChange={noop} senders={many} />);
	assert.equal((out.match(/data-allowed-sender=/g) ?? []).length, 12);
	assert.match(out, /12 remetentes/);
	assert.match(out, /aria-label="Buscar remetente"/);
	assert.match(out, /aria-label="Remover pessoa3@empresa.com"/);
	assert.match(out, /aria-label="Adicionar remetente permitido"/);
});

test("página: busca filtra e mostra 'N de M'; sem resultado mostra aviso", () => {
	const some = html(<AllowedSendersManager busy={false} initialQuery="pessoa1" onChange={noop} senders={many} />);
	assert.equal((some.match(/data-allowed-sender=/g) ?? []).length, 3);
	assert.match(some, /3 de 12 remetentes/);
	const none = html(<AllowedSendersManager busy={false} initialQuery="zzz" onChange={noop} senders={many} />);
	assert.match(none, /senders-no-match/);
});

test("página: lista vazia mostra o estado vazio", () => {
	const out = html(<AllowedSendersManager busy={false} onChange={noop} senders={[]} />);
	assert.match(out, /senders-empty/);
	assert.match(out, /Nenhum remetente permitido/);
});

test("endereço da página de remetentes na URL", () => {
	assert.equal(parseSendersLocation("?remetentes=bot-1"), "bot-1");
	assert.equal(parseSendersLocation("?x=1"), null);
	assert.equal(buildSendersSearch("?x=1", "bot-1"), "?x=1&remetentes=bot-1");
	assert.equal(buildSendersSearch("?x=1&remetentes=bot-1", null), "?x=1");
});
