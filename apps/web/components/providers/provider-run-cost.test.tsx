import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { providerCostLabel, ProviderRunCost } from "./provider-run-cost";
Object.assign(globalThis, { React });
test("plano não inventa custo monetário e explica a cota", () => {
 assert.equal(providerCostLabel({ planCalls: 2 }), "plano");
 const html = renderToStaticMarkup(<ProviderRunCost usage={{ provider: "chatgpt" }} />);
 assert.match(html, /cota do seu plano ChatGPT/); assert.doesNotMatch(html, /US\$/);
});
test("custo monetário conhecido permanece em uso misto", () => {
 assert.match(providerCostLabel({ costUsd: 0.02, planCalls: 1 }), /0.0200.*plano/);
});
test("uso misto preserva OpenRouter gratuito ou custo desconhecido", () => {
 assert.match(providerCostLabel({ costUsd: 0, planCalls: 1 }), /0.0000.*plano/);
 assert.match(providerCostLabel({ costUnknownCalls: 1, planCalls: 1 }), /desconhecido.*plano/);
});
