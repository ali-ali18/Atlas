import { describe, expect, it } from "vitest";
import { normalizeRunInputMode, parseRunInputMode } from "./runs.js";

describe("modos de RunInput", () => {
	it("ausente vira join (padrão)", () => {
		expect(parseRunInputMode(undefined)).toBe("join");
		expect(parseRunInputMode(null)).toBe("join");
	});

	it("aceita todos os modos novos", () => {
		for (const mode of ["join", "redirect", "interrupt", "queue", "cancel"]) {
			expect(parseRunInputMode(mode)).toBe(mode);
		}
	});

	it("steer legado é lido como join", () => {
		expect(parseRunInputMode("steer")).toBe("join");
		expect(normalizeRunInputMode("steer")).toBe("join");
	});

	it("modo desconhecido é rejeitado na validação e vira join na leitura", () => {
		expect(parseRunInputMode("nope")).toBeNull();
		expect(parseRunInputMode(7)).toBeNull();
		expect(normalizeRunInputMode("nope")).toBe("join");
	});
});
