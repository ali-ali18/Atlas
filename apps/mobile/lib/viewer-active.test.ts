import { describe, expect, it } from "vitest";
import { viewerActive } from "./viewer-active";

describe("viewerActive (focada e app ativo)", () => {
	it("só monta e conecta com a tela em foco e o app ativo", () => {
		expect(viewerActive(true, "active")).toBe(true);
	});
	it("tela de baixo da pilha (outra tela por cima) desmonta, mesmo com o app ativo", () => {
		expect(viewerActive(false, "active")).toBe(false);
	});
	it("app em segundo plano ou inativo desmonta, mesmo com a tela em foco", () => {
		for (const state of ["background", "inactive", "unknown", ""]) expect(viewerActive(true, state)).toBe(false);
	});
	it("sem foco e sem app ativo, nada", () => {
		expect(viewerActive(false, "background")).toBe(false);
	});
});
