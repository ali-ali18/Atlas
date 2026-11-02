import { describe, expect, it } from "vitest";
import { iconColorOn } from "./icon-color";

describe("iconColorOn", () => {
	it("ícone branco sobre as cores dos bots (laranja, verde, azul)", () => {
		expect(iconColorOn("#ff6a00")).toBe("#ffffff");
		expect(iconColorOn("#00c46a")).toBe("#ffffff");
		expect(iconColorOn("#0a84ff")).toBe("#ffffff");
	});
	it("ícone escuro sobre bot branco, para não sumir", () => {
		expect(iconColorOn("#ffffff")).toBe("#09090b");
	});
	it("cor fora do formato cai no branco", () => {
		expect(iconColorOn("rgb(0,0,0)")).toBe("#ffffff");
	});
});
