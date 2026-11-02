import { afterEach, describe, expect, it } from "vitest";
import { clearDraft, getDraft, initDraft, updateDraft } from "./bot-draft";

const base = { name: "A", shape: "blob", color: "#000000", language: "auto" };
afterEach(() => clearDraft("b"));

describe("rascunho do Editar Bot", () => {
	it("a tela de Avatar altera só forma e cor; o nome digitado fica", () => {
		initDraft("b", { ...base, name: "Digitado" });
		updateDraft("b", { shape: "hex", color: "#1084FE" });
		expect(getDraft("b")).toEqual({ name: "Digitado", shape: "hex", color: "#1084FE", language: "auto" });
	});
	it("atualizar sem rascunho não cria nada; limpar apaga", () => {
		updateDraft("b", { name: "x" });
		expect(getDraft("b")).toBeNull();
		initDraft("b", base);
		clearDraft("b");
		expect(getDraft("b")).toBeNull();
	});
	it("iniciar de novo (StrictMode, remontagem) não zera o que já foi editado", () => {
		initDraft("b", base);
		updateDraft("b", { name: "Editado" });
		initDraft("b", base);
		expect(getDraft("b")?.name).toBe("Editado");
		clearDraft("b"); // o cleanup do primeiro ciclo
		initDraft("b", base); // e o segundo ciclo recria
		expect(getDraft("b")).toEqual(base);
	});
});
