import { describe, expect, it } from "vitest";
import { readCodeMode, withCodeMode } from "./code-mode.js";

describe("modo de código do bot (policyJson.codeMode)", () => {
	it("padrão desligado: sem política, sem a chave, valor inválido ou de outro tipo", () => {
		for (const policy of [undefined, null, {}, [], "build", 3, { codeMode: "" }, { codeMode: "BUILD" }, { codeMode: true }, { codeMode: "admin" }]) expect(readCodeMode(policy)).toBe("off");
	});

	it("lê plan e build", () => {
		expect(readCodeMode({ codeMode: "plan" })).toBe("plan");
		expect(readCodeMode({ codeMode: "build", engine: "v2" })).toBe("build");
	});

	it("grava sem perder as outras chaves; off remove a chave", () => {
		const policy = { engine: "v2", rules: [{ match: "x" }] };
		expect(withCodeMode(policy, "build")).toEqual({ ...policy, codeMode: "build" });
		expect(withCodeMode({ ...policy, codeMode: "plan" }, "off")).toEqual(policy);
		expect(policy).toEqual({ engine: "v2", rules: [{ match: "x" }] });
		expect(withCodeMode(null, "plan")).toEqual({ codeMode: "plan" });
	});
});
