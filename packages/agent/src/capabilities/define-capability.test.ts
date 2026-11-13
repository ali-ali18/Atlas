import { describe, expect, it } from "vitest";
import { defineCapability } from "./define-capability.js";
import { fakeTool } from "./fixtures.js";

const ok = { id: "shopping", title: "Compras", summary: "Find products and compare prices.", tools: [fakeTool("product_search")] };

describe("defineCapability", () => {
	it("aceita a forma válida e congela", () => {
		const cap = defineCapability(ok);
		expect(cap).toMatchObject({ id: "shopping", core: false, cards: [], evals: [] });
		expect(Object.isFrozen(cap)).toBe(true);
	});
	it("summary: uma linha, não vazio, até 160", () => {
		expect(() => defineCapability({ ...ok, summary: "a\nb" })).toThrow(/single line/);
		expect(() => defineCapability({ ...ok, summary: "" })).toThrow(/empty summary/);
		expect(() => defineCapability({ ...ok, summary: "x".repeat(161) })).toThrow(/161 characters/);
		expect(defineCapability({ ...ok, summary: "x".repeat(160) }).summary).toHaveLength(160);
	});
	it("id inválido", () => {
		expect(() => defineCapability({ ...ok, id: "Compras!" })).toThrow(/invalid id/);
	});
	it("tool tem de vir de defineTool", () => {
		const forged = { ...fakeTool("fake") };
		expect(() => defineCapability({ ...ok, tools: [forged] })).toThrow(/defineTool/);
	});
	it("nome de tool repetido na mesma capacidade", () => {
		expect(() => defineCapability({ ...ok, tools: [fakeTool("a"), fakeTool("a")] })).toThrow(/duplicate tool "a"/);
	});
	it("gancho só para tool da própria capacidade", () => {
		expect(() => defineCapability({ ...ok, hooks: { afterTool: { outra: () => undefined } } })).toThrow(/not a tool of this capability/);
		expect(defineCapability({ ...ok, hooks: { beforeTool: { product_search: () => undefined } } }).hooks.beforeTool).toBeDefined();
	});
});
