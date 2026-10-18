import { describe, expect, it } from "vitest";
import {
	CHATGPT_FALLBACK_MODEL,
	resolveChatgptFallbackModel,
	resolveMaintenanceModel,
	resolveRoutineProviderModel,
	inheritedSubagentModel,
} from "./provider-policy.js";
describe("política do plano", () => {
	it("fallback default, none e OpenRouter explícito; nunca plano como fallback", () => {
		expect(resolveChatgptFallbackModel({})).toBe(CHATGPT_FALLBACK_MODEL);
		expect(
			resolveChatgptFallbackModel({ chatgptFallbackModel: null })
		).toBeNull();
		expect(
			resolveChatgptFallbackModel({
				chatgptFallbackModel: "openai/gpt-4o-mini",
			})
		).toBe("openai/gpt-4o-mini");
		expect(() =>
			resolveChatgptFallbackModel({ chatgptFallbackModel: "chatgpt/luna" })
		).toThrow();
	});
	it("manutenção permanece OpenRouter", () => {
		expect(
			resolveMaintenanceModel("chatgpt/luna", CHATGPT_FALLBACK_MODEL)
		).toBe(CHATGPT_FALLBACK_MODEL);
		expect(
			resolveMaintenanceModel("openai/gpt-4o-mini", CHATGPT_FALLBACK_MODEL)
		).toBe("openai/gpt-4o-mini");
		expect(() => resolveMaintenanceModel(null, "chatgpt/luna")).toThrow();
	});
	it("rotina exige opt-in para o plano, sem fallback devolve null", () => {
		expect(
			resolveRoutineProviderModel("chatgpt/luna", false, CHATGPT_FALLBACK_MODEL)
		).toBe(CHATGPT_FALLBACK_MODEL);
		expect(resolveRoutineProviderModel("chatgpt/luna", false, null)).toBeNull();
		expect(resolveRoutineProviderModel("chatgpt/luna", true, null)).toBe(
			"chatgpt/luna"
		);
	});
	it("filhos herdam provedor e override só dentro dele", () => {
		expect(inheritedSubagentModel("chatgpt/luna", "openai/gpt-4o-mini")).toBe(
			"chatgpt/luna"
		);
		expect(inheritedSubagentModel("openai/gpt-4o-mini", "chatgpt/luna")).toBe(
			"openai/gpt-4o-mini"
		);
		expect(inheritedSubagentModel("chatgpt/luna", "chatgpt/sol")).toBe(
			"chatgpt/sol"
		);
	});
});
