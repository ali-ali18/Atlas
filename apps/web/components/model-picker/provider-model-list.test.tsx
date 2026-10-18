import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderGroup, chatgptGroupMessage } from "./provider-model-list";
Object.assign(globalThis, { React });
test("grupos de provedor começam fechados com botão acessível", () => {
 const html = renderToStaticMarkup(<ProviderGroup name="ChatGPT (plano)" count={2}><span>modelo secreto</span></ProviderGroup>);
 assert.match(html, /<button/); assert.match(html, /aria-expanded="false"/); assert.doesNotMatch(html, /modelo secreto/);
});
test("estado do login difere de indisponibilidade do catálogo", () => {
 assert.equal(chatgptGroupMessage(null, false), "Conectar ChatGPT");
 const status = { provider: "chatgpt" as const, status: "connected" as const, accountEmail: null, updatedAt: null, lastLimitAt: null };
 assert.equal(chatgptGroupMessage(status, false), "Catálogo temporariamente indisponível.");
 assert.equal(chatgptGroupMessage({ ...status, status: "needs_login" }, true), "Reconecte o ChatGPT");
});
test("linha do seletor mostra selos de capacidade e contexto", async () => {
 const { PickerModelRow } = await import("./provider-model-list");
 const { Command } = await import("cmdk");
 const model = { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5", provider: "openrouter" as const, vendor: "anthropic", contextLength: 200000, capabilities: "unknown" as const };
 const html = renderToStaticMarkup(<Command><PickerModelRow model={model} onSelect={() => undefined} /></Command>);
 for (const label of ["Imagem", "PDF", "Ferramentas", "200k"]) assert.match(html, new RegExp(label));
 const plain = renderToStaticMarkup(<Command><PickerModelRow model={{ ...model, id: "acme/x", name: "X", contextLength: 8000 }} onSelect={() => undefined} /></Command>);
 assert.doesNotMatch(plain, /Imagem|PDF/); assert.match(plain, /8k/);
});
