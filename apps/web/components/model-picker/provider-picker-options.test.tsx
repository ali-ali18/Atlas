import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Command, CommandList } from "@workspace/ui/components/command";
import { normalizePickerModels } from "@/lib/provider-model-picker";
import { ProviderPickerOptions } from "./provider-picker-options";
Object.assign(globalThis, { React });
const models = normalizePickerModels([{ id: "openai/gpt-4o-mini", name: "Mini", provider: "openai", contextLength: 128000 }, { id: "chatgpt/luna", name: "Luna", provider: "chatgpt", contextLength: null }]);
function render(value: string, query = "", available = true) {
 return renderToStaticMarkup(<Command shouldFilter={false}><CommandList><ProviderPickerOptions models={models} value={value} query={query} available={available} status={null} catalogAvailable={false} onSelect={() => {}} onConnect={() => {}} /></CommandList></Command>);
}
test("modelo oculto ou desconectado continua no topo com aviso", () => {
 const html = render("chatgpt/hidden", "", false);
 assert.ok(html.indexOf("chatgpt/hidden") < html.indexOf("Mostrar modelos de OpenRouter"));
 assert.match(html, /ChatGPT indisponível/); assert.doesNotMatch(html, /Mostrar modelos de ChatGPT/);
});
test("busca retorna opção de qualquer provedor sem abrir grupos", () => {
 const html = render("openai/gpt-4o-mini", "luna");
 assert.match(html, /Luna/); assert.doesNotMatch(html, /Mostrar modelos de/);
});
test("sem busca os dois grupos permanecem fechados", () => {
 const html = render("openai/gpt-4o-mini");
 assert.equal((html.match(/aria-expanded="false"/g) ?? []).length, 2);
 assert.doesNotMatch(html, /Luna/);
});
test("linha do seletor mostra só o nome do modelo, sem fornecedor nem contexto", () => {
 const rows = normalizePickerModels([{ id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek: DeepSeek V4.1 Flash", provider: "deepseek", contextLength: 128000 }]);
 const html = renderToStaticMarkup(<Command shouldFilter={false}><CommandList><ProviderPickerOptions models={rows} value="" query="deepseek" available status={null} catalogAvailable={false} onSelect={() => {}} onConnect={() => {}} /></CommandList></Command>);
 assert.match(html, />DeepSeek V4\.1 Flash</); assert.doesNotMatch(html, /DeepSeek: /); assert.doesNotMatch(html, /dk ctx|US$/);
});
