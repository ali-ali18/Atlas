import { describe, expect, it } from "vitest";
import { disciplineForModel, disciplineLevelForModel } from "./model-discipline.js";

describe("disciplina de execução por família de modelo", () => {
	it.each([
		["anthropic/claude-sonnet-4.5", "minimal"],
		["claude-opus-4-1", "minimal"],
		["google/gemini-2.5-flash", "standard"],
		["deepseek/deepseek-chat-v3.1", "full"],
		["qwen/qwen3-coder", "full"],
		["z-ai/glm-4.6", "full"],
		["moonshotai/kimi-k2", "full"],
		["openai/gpt-5-mini", "full"],
		["openai/o4-mini", "full"],
		["o3", "full"],
		["meta-llama/llama-3.3-70b", "full"],
		["", "full"],
	] as const)("%s -> %s", (model, level) => {
		expect(disciplineLevelForModel(model)).toBe(level);
	});

	it("todo modelo (inclusive Claude) recebe o mínimo: terminar no turno e só afirmar o que a tool mostrou", () => {
		for (const model of ["anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro", "deepseek/deepseek-chat"]) {
			const block = disciplineForModel(model);
			expect(block.startsWith("Execution discipline:\n")).toBe(true);
			expect(block).toContain("never end with a promise to check or do it later");
			expect(block).toContain("Claim only what a tool result in this task shows.");
		}
	});

	it("modelo menos agêntico recebe as regras de chamar tool, números por tool, JSON válido e uma pergunta só", () => {
		const full = disciplineForModel("deepseek/deepseek-chat");
		expect(full).toContain("call the tool instead of describing what you would do");
		expect(full).toContain("Numbers come from tools");
		expect(full).toContain("valid JSON that matches the schema");
		expect(full).toContain("Ask at most one question, and only when you are blocked.");
		const claude = disciplineForModel("anthropic/claude-sonnet-4.5");
		expect(claude).not.toContain("valid JSON");
		expect(claude).not.toContain("call the tool instead of describing");
		expect(disciplineForModel("google/gemini-2.5-pro")).toContain("call the tool instead of describing");
		expect(disciplineForModel("google/gemini-2.5-pro")).not.toContain("valid JSON");
	});

	it("é estável (mesmo id, mesmos bytes) e curto", () => {
		expect(disciplineForModel("Qwen/Qwen3-235B")).toBe(disciplineForModel("qwen/qwen3-235b"));
		expect(disciplineForModel("deepseek/deepseek-chat").length).toBeLessThan(1_300);
		expect(disciplineForModel("deepseek/deepseek-chat")).not.toMatch(/NEVER|NUNCA|IMPORTANT/);
	});
});
