import { describe, expect, it } from "vitest";
import {
	RESEARCH_BUDGET_DEFAULTS,
	mergeResearchBudget,
} from "./research-budget.js";

describe("mergeResearchBudget", () => {
	it("preenche defaults sem env/política", () => {
		const merged = mergeResearchBudget(undefined);
		expect(merged.web_search).toBe(RESEARCH_BUDGET_DEFAULTS.web_search);
		expect(merged.web_extract).toBe(RESEARCH_BUDGET_DEFAULTS.web_extract);
		expect(merged.screenshot).toBeUndefined();
		expect(merged.click).toBeUndefined();
		expect(merged.maxSteps).toBeUndefined();
	});

	it("não sobrescreve valores explícitos nem apaga extras", () => {
		const merged = mergeResearchBudget({ web_search: 2, navigate: 50 });
		expect(merged.web_search).toBe(2);
		expect(merged.navigate).toBe(50);
		expect(merged.web_extract).toBe(RESEARCH_BUDGET_DEFAULTS.web_extract);
	});

	it("ignora valores inválidos", () => {
		const merged = mergeResearchBudget({ web_search: 0, click: -3 });
		expect(merged.web_search).toBe(RESEARCH_BUDGET_DEFAULTS.web_search);
		expect(merged.click).toBeUndefined();
	});
});
