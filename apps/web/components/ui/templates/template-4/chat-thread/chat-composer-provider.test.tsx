import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatComposer } from "./chat-composer";
Object.assign(globalThis, { React });
test("composer não exibe custo nem plano, mas mantém a nota de fallback", () => {
 const html = renderToStaticMarkup(<ChatComposer agentName="Fixture" model="deepseek/deepseek-v4.1-flash" servedModel="openai/gpt-4o-mini" onSend={() => {}} />);
 assert.doesNotMatch(html, /US\$|cota do seu plano|>plano</); assert.match(html, /via gpt-4o-mini/);
});
test("modelo escolhido sozinho não mostra nota de fallback", () => {
 const html = renderToStaticMarkup(<ChatComposer agentName="Fixture" model="chatgpt/luna" onSend={() => {}} />);
 assert.doesNotMatch(html, /via /);
});
