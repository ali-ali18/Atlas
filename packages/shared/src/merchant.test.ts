import { describe, expect, it } from "vitest";
import { normalizeMerchant } from "./merchant.js";

describe("normalizeMerchant", () => {
	it("URL, www, maiúscula e barra final viram o mesmo domínio", () => {
		expect(normalizeMerchant("https://loja.com")).toBe("loja.com");
		expect(normalizeMerchant("https://www.Loja.com/checkout?a=1")).toBe("loja.com");
		expect(normalizeMerchant("www.loja.com")).toBe("loja.com");
		expect(normalizeMerchant("Loja.com/")).toBe("loja.com");
		expect(normalizeMerchant("  LOJA.com.br  ")).toBe("loja.com.br");
		expect(normalizeMerchant("loja.com.")).toBe("loja.com");
	});

	it("domínio acentuado vira punycode (o mesmo que o navegador paga)", () => {
		expect(normalizeMerchant("lojá.com.br")).toBe("xn--loj-gla.com.br");
		expect(normalizeMerchant("https://www.Lojá.com.br/x")).toBe("xn--loj-gla.com.br");
	});

	it("subdomínio que não é www continua distinto", () => {
		expect(normalizeMerchant("pagamento.loja.com")).toBe("pagamento.loja.com");
	});

	it("recusa lixo: vazio, texto solto, IP, localhost, porta inválida, protocolo estranho, credenciais, espaço", () => {
		for (const bad of ["", "   ", "loja", "minha loja.com", "127.0.0.1", "http://10.0.0.1/x", "localhost", "https://localhost/pay", "ftp://loja.com", "javascript:alert(1)", "https://user:pass@loja.com", "-loja.com", "loja..com", "loja.c_m", "https://", "a".repeat(300) + ".com", "loja.123"]) {
			expect(normalizeMerchant(bad), JSON.stringify(bad)).toBeNull();
		}
	});
});
