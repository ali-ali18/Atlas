import { describe, expect, it } from "vitest";
import { EFFECT_CLASSES, EFFECT_DOCS, isEffect } from "./effects.js";

describe("classes de efeito", () => {
	it("são as nove do contrato, em ordem", () => {
		expect([...EFFECT_CLASSES]).toEqual(["read", "draft", "write_internal", "write_external", "send", "money", "public_link", "credential", "destructive"]);
	});
	it("toda classe tem doc em pt-BR não vazio", () => {
		for (const effect of EFFECT_CLASSES) expect(EFFECT_DOCS[effect].length).toBeGreaterThan(10);
		expect(Object.keys(EFFECT_DOCS).sort()).toEqual([...EFFECT_CLASSES].sort());
	});
	it("isEffect rejeita o que não é classe", () => {
		expect(isEffect("send")).toBe(true);
		expect(isEffect("Send")).toBe(false);
		expect(isEffect(undefined)).toBe(false);
	});
});
