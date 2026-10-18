import assert from "node:assert/strict";
import test from "node:test";
import { canUseLegacyChat, normalizePickerModels, pickerRecommendations, pickerViaLabel, searchPickerModels } from "./provider-model-picker";
const models = normalizePickerModels([
	{ id: "openai/gpt-4o-mini", name: "GPT Mini", provider: "openai", contextLength: 128000 },
	{ id: "chatgpt/luna", name: "Luna", provider: "chatgpt", capabilities: "unknown", visibility: "list", contextLength: null },
]);
test("vendors antigos e contratos canônicos convergem sem alterar IDs", () => {
	assert.equal(models[0]?.provider, "openrouter");
	assert.equal(models[0]?.vendor, "openai");
	assert.equal(models[1]?.provider, "chatgpt");
});
test("busca cobre todos provedores sem grupos e recomenda só modelos existentes", () => {
	assert.deepEqual(searchPickerModels(models, "luna chatgpt").map((model) => model.id), ["chatgpt/luna"]);
	assert.deepEqual(searchPickerModels(models, "OPENAI MINI").map((model) => model.id), ["openai/gpt-4o-mini"]);
	assert.deepEqual(pickerRecommendations(models).map((model) => model.id), ["openai/gpt-4o-mini"]);
	assert.deepEqual(pickerRecommendations([]), []);
});
test("fila 503 não chama endpoint legado com modelo ChatGPT", () => {
	assert.equal(canUseLegacyChat("chatgpt/luna", 503, 0), false);
	assert.equal(canUseLegacyChat("openai/gpt-4o-mini", 503, 0), true);
	assert.equal(canUseLegacyChat("openai/gpt-4o-mini", 503, 1), false);
	assert.equal(canUseLegacyChat("openai/gpt-4o-mini", 500, 0), false);
});

test("modelos de chave própria mostram 'via <provedor>' em vez do vendor", () => {
	assert.equal(pickerViaLabel("opencode-go/kimi-k3"), "via OpenCode Go");
	assert.equal(pickerViaLabel("anthropic-direct/claude-sonnet-5-5"), "via Anthropic");
	assert.equal(pickerViaLabel("openai/gpt-4o-mini"), null);
	assert.equal(pickerViaLabel("chatgpt/luna"), null);
});
