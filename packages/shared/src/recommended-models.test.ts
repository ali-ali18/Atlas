import { expect, it } from "vitest";
import { recommendedModels, RECOMMENDED_MODELS } from "./recommended-models.js";
import type { ProviderModel } from "./model.js";

it("sugestões usam apenas modelos presentes na conta, sem inventar slugs", () => {
	const model: ProviderModel = { id: "chatgpt/luna", name: "Luna da conta", provider: "chatgpt", contextLength: null, capabilities: "unknown" };
	expect(recommendedModels([])).toEqual([]);
	expect(recommendedModels([model])).toEqual([model]);
	expect(recommendedModels([{ ...model, id: "chatgpt/other" }])).toEqual([]);
	expect(new Set(RECOMMENDED_MODELS.map((entry) => entry.id)).size).toBe(RECOMMENDED_MODELS.length);
});
