import { describe, expect, it } from "vitest";
import { createRedactor } from "./redact.js";

describe("redação por padrão", () => {
	it("e-mail, CNPJ, CPF e telefone viram marcadores com o mesmo formato", () => {
		const redactor = createRedactor();
		const out = redactor.text("Fale com Joana <Joana.Silva@empresa.com.br>, CNPJ 11.222.333/0001-81, CPF 123.456.789-09, fone (41) 99876-5432 ou +55 41 3333-1234.");
		expect(out).toBe("Fale com Joana <contato1@exemplo.com>, CNPJ 00.000.001/0001-00, CPF 000.000.001-00, fone (11) 90000-0001 ou (11) 90000-0002.");
		expect(redactor.counts()).toMatchObject({ email: 1, cnpj: 1, cpf: 1, phone: 2 });
	});

	it("o mesmo valor vira sempre o mesmo marcador (com e sem máscara)", () => {
		const redactor = createRedactor();
		expect(redactor.text("11.222.333/0001-81 e 11222333000181 e 11.111.111/0001-11")).toBe("00.000.001/0001-00 e 00.000.001/0001-00 e 00.000.002/0001-00");
		expect(redactor.text("joana@x.com JOANA@x.com")).toBe("contato1@exemplo.com contato1@exemplo.com");
	});

	it("segredos somem (chaves, Bearer, JWT, query string)", () => {
		const redactor = createRedactor();
		const out = redactor.text(
			"key sk-or-v1-abcdefghijklmnopqrstuvwxyz012345 Authorization: Bearer abcdefghijklmnop123 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl url https://x.test/cb?code=abc123&state=zzz ghp_abcdefghijklmnopqrstuvwxyz0123",
		);
		expect(out).not.toMatch(/sk-or-v1|abcdefghijklmnop123|eyJhbGci|abc123|zzz|ghp_/);
		expect(out).toContain("code=[segredo]");
	});

	it("dinheiro, datas, CEP e números curtos ficam", () => {
		const redactor = createRedactor();
		const text = "Nota R$ 1.712,67, 7 volumes, 43 kg, CEP 01001-000, em 2025-10-03 às 10h, pedido 3410.";
		expect(redactor.text(text)).toBe(text);
	});

	it("profundo: objetos e listas, sem mudar números e booleanos", () => {
		const redactor = createRedactor();
		expect(redactor.deep({ a: ["x@y.com", 3, true], b: { c: "(41) 99876-5432" } })).toEqual({ a: ["contato1@exemplo.com", 3, true], b: { c: "(11) 90000-0001" } });
	});
});
