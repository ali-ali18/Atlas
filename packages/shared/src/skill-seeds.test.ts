import { describe, expect, it } from "vitest";
import { parseSkillRecipe } from "./skills.js";
import { SKILL_AVAILABLE_TOOLS } from "./skill-extract.js";
import { AGENTIC_SKILL_SEEDS } from "./skill-seeds.js";

const AVAILABLE = [...SKILL_AVAILABLE_TOOLS, "web_search", "web_extract"] as const;

describe("agentic skill seeds", () => {
	it("expoe 3 sementes", () => {
		expect(AGENTIC_SKILL_SEEDS).toHaveLength(3);
		expect(AGENTIC_SKILL_SEEDS.map((s) => s.capabilityKey).sort()).toEqual(
			["browser-hygiene", "price-check", "tool-escalation"].sort(),
		);
	});

	it("passa em parseSkillRecipe com web_* disponiveis", () => {
		for (const seed of AGENTIC_SKILL_SEEDS) {
			const parsed = parseSkillRecipe(seed, AVAILABLE as unknown as string[]);
			expect(parsed.capabilityKey).toBe(seed.capabilityKey);
			// step tool precisa estar declarado em requiredTools
			for (const step of parsed.steps) {
				expect(parsed.requiredTools).toContain(step.tool);
			}
			// limites: arrays 1-16 e payload 24k
			expect(parsed.triggers.length).toBeGreaterThanOrEqual(1);
			expect(parsed.triggers.length).toBeLessThanOrEqual(16);
			expect(parsed.steps.length).toBeGreaterThanOrEqual(1);
			expect(parsed.steps.length).toBeLessThanOrEqual(16);
			expect(JSON.stringify(parsed).length).toBeLessThanOrEqual(24000);
		}
	});

	it("tool-escalation segue web_search -> web_extract -> navegador", () => {
		const seed = AGENTIC_SKILL_SEEDS.find((s) => s.capabilityKey === "tool-escalation")!;
		expect(seed).toBeDefined();
		const tools = seed.steps.map((s) => s.tool);
		expect(tools[0]).toBe("web_search");
		expect(tools[1]).toBe("web_extract");
		expect(tools).toContain("navigate");
		expect(tools).toContain("browser_text");
		// triggers cobrem escalar ferramenta, bloqueado e login
		const joined = seed.triggers.join(" ").toLowerCase();
		expect(joined).toContain("escalar ferramenta");
		expect(joined).toContain("bloquead");
		expect(joined).toContain("login");
		// requiredTools cobre exatamente os steps (subset mutuo)
		expect([...seed.requiredTools].sort()).toEqual([...new Set(tools)].sort());
	});

	it("browser-hygiene usa somente navigate/browser_*", () => {
		const seed = AGENTIC_SKILL_SEEDS.find((s) => s.capabilityKey === "browser-hygiene")!;
		const allowed = new Set([
			"navigate",
			"browser_text",
			"browser_links",
			"browser_click",
			"browser_type",
		]);
		for (const step of seed.steps) {
			expect(allowed.has(step.tool)).toBe(true);
		}
		const text = JSON.stringify(seed).toLowerCase();
		expect(text).toContain("uma tarefa por vez");
		expect(text).toContain("aguardar");
		expect(text).toContain("cookies");
		expect(text).toContain("captura de tela");
		expect(text).toContain("resumo ia");
		expect(text).toContain("sessao");
	});

	it("price-check usa web_search + web_extract + browser_text", () => {
		const seed = AGENTIC_SKILL_SEEDS.find((s) => s.capabilityKey === "price-check")!;
		expect([...seed.requiredTools].sort()).toEqual(
			["browser_text", "web_extract", "web_search"].sort(),
		);
		const text = JSON.stringify(seed).toLowerCase();
		expect(text).toContain("3 a 5");
		expect(text).toContain("dominios diferentes");
		for (const field of ["store", "product", "price", "currency", "availability", "url"]) {
			expect(text).toContain(field);
		}
		expect(text).toContain("data");
		expect(text).toContain("vazio");
	});
});
