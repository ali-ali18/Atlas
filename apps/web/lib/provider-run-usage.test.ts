import assert from "node:assert/strict";
import test from "node:test";
import { readProviderRunUsage } from "./provider-run-usage";
test("usage antigo não inventa custo e plano medido mantém marcador", () => {
 assert.equal(readProviderRunUsage(null), null); assert.equal(readProviderRunUsage({}), null);
 assert.deepEqual(readProviderRunUsage({ promptTokens: 2, completionTokens: 3, totalTokens: 5, planCalls: 1 }), { promptTokens: 2, completionTokens: 3, totalTokens: 5, planCalls: 1 });
});
test("usage misto preserva zero conhecido e custo desconhecido sem aceitar campos inválidos", () => {
 assert.deepEqual(readProviderRunUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0, planCalls: 1, costUnknownCalls: 2, costUsd: 0 }), { promptTokens: 0, completionTokens: 0, totalTokens: 0, planCalls: 1, costUnknownCalls: 2, costUsd: 0 });
 assert.equal(readProviderRunUsage({ promptTokens: -1, completionTokens: 0, totalTokens: 0 }), null);
});
