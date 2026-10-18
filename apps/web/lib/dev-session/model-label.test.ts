import assert from "node:assert/strict";
import test from "node:test";
import { devModelLabel } from "./model-label";

test("usa o nome do catálogo sem o fornecedor", () => {
	assert.equal(devModelLabel("anthropic/claude-sonnet-5.5", [{ id: "anthropic/claude-sonnet-5.5", name: "Anthropic: Claude Sonnet 5.5" }]), "Claude Sonnet 5.5");
});

test("fora do catálogo humaniza o slug", () => {
	assert.equal(devModelLabel("anthropic/claude-sonnet-5.5"), "Claude Sonnet 5.5");
	assert.equal(devModelLabel("chatgpt/luna"), "Luna");
});
