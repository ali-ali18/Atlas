import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CompactionCard, CompactionNotice } from "./compaction-card";

Object.assign(globalThis, { React });

const SUMMARY = "Objetivo: montar a proposta do cliente Alfa.\nPendente: forma de pagamento.";

test("marcador: título, números antes → depois e percentual, sem resumo nem linhas", () => {
	const html = renderToStaticMarkup(<CompactionCard after={6_100} before={48_200} focus="preço" summary={SUMMARY} />);
	assert.match(html, /data-testid="compaction-card"/);
	assert.match(html, /Conversa compactada/);
	assert.match(html, /48,2 mil → 6,1 mil tokens \(−87%\)/);
	assert.doesNotMatch(html, /aria-expanded/);
	assert.doesNotMatch(html, /Objetivo: montar a proposta/);
	assert.doesNotMatch(html, /data-variant="separator"/);
});

test("conversas pequenas: números abaixo de mil aparecem inteiros", () => {
	const html = renderToStaticMarkup(<CompactionCard after={900} before={4_000} summary="x" />);
	assert.match(html, /4,0 mil → 900 tokens \(−78%\)/);
});

test("aviso passageiro: trabalhando e aviso curto", () => {
	const working = renderToStaticMarkup(<CompactionNotice state={{ status: "working" }} />);
	assert.match(working, /data-state="working"/);
	assert.match(working, /Compactando a conversa…/);
	const notice = renderToStaticMarkup(<CompactionNotice state={{ status: "notice", text: "A conversa ainda é curta; não há o que compactar." }} />);
	assert.match(notice, /data-state="notice"/);
	assert.match(notice, /não há o que compactar/);
	assert.match(notice, /role="status"/);
});
