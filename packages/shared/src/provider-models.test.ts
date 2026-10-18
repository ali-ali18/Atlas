import { expect, it } from "vitest";
import { parseChatgptModels, visibleProviderModels } from "./provider-models.js";

it("catálogo do spike conserva referência e oculta modelos fora da lista", () => {
	const models = parseChatgptModels({ models: [{ slug: "luna", display_name: "Luna", visibility: "list" }, { slug: "hidden", visibility: "hidden" }, { slug: "../bad", visibility: "list" }] });
	expect(models.map((model) => model.id)).toEqual(["chatgpt/luna", "chatgpt/hidden"]);
	expect(models[0]).toMatchObject({ contextLength: null, capabilities: "unknown" });
	expect(models[0]).not.toHaveProperty("inputModalities");
	expect(visibleProviderModels(models)).toHaveLength(1);
	expect(visibleProviderModels(models, "chatgpt/hidden")).toHaveLength(2);
});

it("só capacidades e contexto explícitos habilitam visão", () => {
	const models = parseChatgptModels({ data: [{ slug: "m", visibility: "list", capabilities: { vision: true, tools: false }, context_length: 32000 }, { slug: "m2", context_length: -1, supports_vision: false }] });
	expect(models[0]).toMatchObject({ capabilities: { vision: true, tools: false }, contextLength: 32000, inputModalities: ["text", "image"] });
	expect(models[1]).toMatchObject({ contextLength: null, inputModalities: ["text"] });
	expect(parseChatgptModels(null)).toEqual([]);
});
