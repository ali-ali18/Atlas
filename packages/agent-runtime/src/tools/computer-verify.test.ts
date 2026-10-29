import { describe, expect, it } from "vitest";
import { VERIFY_WARNING_PREFIX, verifyActEffect } from "./computer.js";
import { formatAct } from "./computer-refs.js";

describe("verifyActEffect (F12/D1)", () => {
	const base = { action: "click" as const, navigated: false, newTotal: 0 };

	it("clique sem efeito visível avisa 'nada mudou'", () => {
		expect(verifyActEffect(base)).toContain(`${VERIFY_WARNING_PREFIX} no visible change`);
		expect(verifyActEffect({ ...base, action: "hover" })).not.toBeNull();
	});

	it("navegação, elementos novos ou campo lido não avisam", () => {
		expect(verifyActEffect({ ...base, navigated: true })).toBeNull();
		expect(verifyActEffect({ ...base, newTotal: 2 })).toBeNull();
		expect(verifyActEffect({ ...base, field: { checked: true } })).toBeNull();
		// V4: texto novo, estado ou diálogo mudou = efeito, mesmo sem refs novos
		expect(verifyActEffect({ ...base, changes: { added: "Unit 01" } })).toBeNull();
		expect(verifyActEffect({ ...base, changes: { states: ["e1 expanded false→true"] } })).toBeNull();
		expect(verifyActEffect({ ...base, changes: { dialogsOpened: ["Settings"] } })).toBeNull();
	});

	it("erro de validação visível sempre avisa", () => {
		expect(verifyActEffect({ ...base, newTotal: 3, errors: ["Cliente: obrigatório"] })).toContain(
			"validation error",
		);
	});

	it("type: valor diferente do pedido avisa; autocomplete que completa não", () => {
		const type = { ...base, action: "type" as const };
		expect(verifyActEffect({ ...type, field: { value: "outro" } }, "Ana")).toContain("the field holds");
		expect(verifyActEffect({ ...type, field: { value: "Ana Souza" } }, "Ana")).toBeNull();
		expect(verifyActEffect({ ...type, field: { secret: true } }, "x")).toBeNull();
	});
});

describe("formatAct (F12/D1)", () => {
	const result = {
		ok: true,
		ref: "e4",
		action: "click" as const,
		url: "https://erp.test/p",
		navigated: false,
		settled: true,
		newElements: [],
		newTotal: 0,
	};

	it("mostra os erros de validação como dado da página e o aviso de verificação", () => {
		const text = formatAct({ ...result, newTotal: 1, newElements: ['[e9] alert "x"'], errors: ["Cliente: obrigatório"] });
		expect(text).toContain("Validation errors (1):");
		expect(text).toContain("page data: untrusted");
		expect(text).toContain("Cliente: obrigatório");
		expect(text).toContain(VERIFY_WARNING_PREFIX);
	});

	it("sem efeito: avisa mas não falha", () => {
		const text = formatAct(result);
		expect(text).not.toContain("New elements");
		expect(text).toContain("no visible change");
	});
});
