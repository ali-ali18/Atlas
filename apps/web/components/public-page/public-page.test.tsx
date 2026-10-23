import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parsePageSpec } from "@workspace/shared";
import { fetchSharedPage, PublicPageContent, type SharedPage } from "./public-page";

Object.assign(globalThis, { React });

const parsed = parsePageSpec({ v: 2, title: "Vendas", summary: "Resumo", root: { type: "stack", children: [{ type: "stat", props: { label: "Receita", value: 10 } }] } });
if (!parsed.ok) throw new Error(parsed.error);
const page: SharedPage = { title: "Vendas da semana", summary: "Receita acima da meta", spec: parsed.spec, updatedAt: "2026-10-26T10:00:00.000Z", botName: "Atlas Vendas" };
const now = new Date("2026-10-26T12:00:00.000Z");

test("painel público: título, resumo, o painel desenhado e o rodapé somente leitura", () => {
	const html = renderToStaticMarkup(<PublicPageContent now={now} state={{ kind: "ready", page }} />);
	assert.match(html, /<h1[^>]*>Vendas da semana<\/h1>/);
	assert.match(html, /Receita acima da meta/);
	assert.match(html, /data-testid="page-stat"/);
	assert.match(html, /Painel de Atlas Vendas · somente leitura · Atualizado há 2 h/);
	assert.doesNotMatch(html, /<button/);
});

test("link desativado, erro e carregando têm estados próprios", () => {
	assert.match(renderToStaticMarkup(<PublicPageContent state={{ kind: "gone" }} />), /Este link não está mais disponível/);
	assert.match(renderToStaticMarkup(<PublicPageContent state={{ kind: "error" }} />), /role="alert"/);
	assert.match(renderToStaticMarkup(<PublicPageContent state={{ kind: "loading" }} />), /public-page-loading/);
});

test("fetchSharedPage: sem credenciais, 404 vira gone, falha de rede vira error", async () => {
	const original = globalThis.fetch;
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	try {
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			if (url.endsWith("/gone")) return new Response("{}", { status: 404 });
			if (url.endsWith("/boom")) throw new Error("rede");
			return new Response(JSON.stringify({ page }), { status: 200 });
		}) as typeof fetch;
		assert.equal((await fetchSharedPage("ok")).kind, "ready");
		assert.equal((await fetchSharedPage("gone")).kind, "gone");
		assert.equal((await fetchSharedPage("boom")).kind, "error");
		assert.equal(calls[0]!.url, "/v1/public/paineis/ok");
		assert.equal(calls[0]!.init?.credentials, "omit");
	} finally {
		globalThis.fetch = original;
	}
});
