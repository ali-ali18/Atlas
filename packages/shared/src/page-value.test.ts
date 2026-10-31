import { describe, expect, it } from "vitest";
import { parseLocalizedNumber } from "./alert-rule-extract.js";
import { anchorStillNear, b3QuotePageReason, deriveAlertAnchor, isNumericPageValue, isStableClass, isStableId, mentionsB3Ticker, pageNumbers, pageTextHasValue, pageValuesMatch } from "./page-value.js";

describe("valor numérico visto na página", () => {
	it("reconhece número com moeda, milhar e decimal em BR e US", () => {
		for (const text of ["16,47", "R$ 16,47", "R$16,47", "3.299,00", "1,234.56", "US$ 9.99", "-3,5%", "1 299,00"]) expect(isNumericPageValue(text), text).toBe(true);
		for (const text of ["Esgotado", "BBAS3", "128 GB", ""]) expect(isNumericPageValue(text), text).toBe(false);
	});

	it("16,47 = 16.47 = R$ 16,47: a mesma normalização do avaliador, tolerância zero", () => {
		expect(pageValuesMatch("R$ 16,47", "16,47")).toBe(true);
		expect(pageValuesMatch("16.47", "R$ 16,47")).toBe(true);
		expect(pageValuesMatch("R$ 3.299,00", "3299")).toBe(true);
		expect(pageValuesMatch("R$ 3.299,00", "3.299")).toBe(true);
		expect(pageValuesMatch("R$ 16,48", "16,47")).toBe(false);
		expect(pageValuesMatch("R$ 116,47", "16,47")).toBe(false);
		expect(pageValuesMatch("", "16,47")).toBe(false);
	});

	it("a leitura vale pelo PRIMEIRO número do texto (como a regra lê), não por qualquer um", () => {
		expect(pageValuesMatch("BBAS3 cotação atual R$ 16,47", "16,47")).toBe(false);
		expect(pageValuesMatch("R$ 16,47 (+0,5%)", "16,47")).toBe(true);
	});

	it("texto: contém o esperado, sem diferenciar caixa nem acento", () => {
		expect(pageValuesMatch("Em estoque (3 un.)", "em ESTOQUE")).toBe(true);
		expect(pageValuesMatch("Indisponível", "indisponivel")).toBe(true);
		expect(pageValuesMatch("Esgotado", "em estoque")).toBe(false);
	});

	it("achar o valor no texto: número inteiro, não pedaço de outro número", () => {
		expect(pageTextHasValue("Cotação R$ 16,47 hoje", "16,47")).toBe(true);
		expect(pageTextHasValue("Máx R$ 116,47", "16,47")).toBe(false);
		expect(pageTextHasValue("Galaxy X 256 GB por R$ 3.299,00", "3299")).toBe(true);
		expect(pageTextHasValue("De 1 299,00 por 999,00", "1299")).toBe(true);
		expect(pageTextHasValue("Disponível em 128 256 512 GB", "256")).toBe(true);
		expect(pageTextHasValue("Em Estoque", "em estoque")).toBe(true);
		expect(pageNumbers("R$ 16,47 e 3.299,00")).toEqual([16.47, 3299]);
	});
});

describe("classe e id estáveis para seletor", () => {
	it("aceita nomes com significado, inclusive com _ e --", () => {
		for (const name of ["price", "value", "_card", "_card-body", "cotacao", "product-price", "js-product-price", "card__title"]) expect(isStableClass(name), name).toBe(true);
	});

	it("recusa classe gerada (CSS-in-JS, CSS modules), utilitária e de estado", () => {
		for (const name of ["css-1a2b3c", "sc-bdfBwQ", "jsx-123456", "Price_price__a1B2c", "svelte-xyz12", "x12345", "mt-4", "text-sm", "flex", "col-md-6", "container", "active", "is-open", "hidden"]) {
			expect(isStableClass(name), name).toBe(false);
		}
	});

	it("recusa nome com caractere que exigiria escape", () => {
		for (const name of ["md:flex", "w-1/2", "a.b", "", "9col"]) expect(isStableClass(name), name).toBe(false);
	});

	it("id: palavra com significado sim; id com número comprido ou hash não", () => {
		expect(isStableId("product-price")).toBe(true);
		expect(isStableId("main")).toBe(true);
		expect(isStableId("product-123456")).toBe(false);
		expect(isStableId("react-select-3-input")).toBe(true);
		expect(isStableId("css-9a8b7c")).toBe(false);
		expect(isStableId("1abc")).toBe(false);
	});
});

describe("ticker da B3 e sites de cotação", () => {
	it("acha ticker de ação, FII, ETF e BDR; ignora palavra comum", () => {
		for (const text of ["BBAS3", "avisa se bbas3 cair", "PETR4", "HGLG11", "BOVA11", "AAPL34", "https://x/acoes/bbas3", "BBAS3:BVMF"]) expect(mentionsB3Ticker(text), text).toBe(true);
		for (const text of ["galaxy s24", "iPhone 15", "AAPL", "ABCD123456", "preço do ouro"]) expect(mentionsB3Ticker(text), text).toBe(false);
	});

	it("recusa página de site de cotação quando a URL ou o pedido citam ticker da B3", () => {
		const reason = b3QuotePageReason("https://investidor10.com.br/acoes/bbas3/", []);
		expect(reason).toContain("source quote (brapi)");
		expect(reason).toContain('propose_connector with app "brapi"');
		expect(b3QuotePageReason("https://statusinvest.com.br/acoes/petr4", [])).not.toBeNull();
		expect(b3QuotePageReason("https://www.google.com/finance/quote/BBAS3:BVMF", [])).not.toBeNull();
		expect(b3QuotePageReason("https://br.investing.com/equities/banco-brasil-on", ["me avisa se a BBAS3 cair abaixo de 15"])).not.toBeNull();
		expect(b3QuotePageReason("https://www.infomoney.com.br/cotacoes/b3/acao/banco-do-brasil-bbas3/", [])).not.toBeNull();
		expect(b3QuotePageReason("https://maisretorno.com/portfolio/bbas3", [])).not.toBeNull();
		expect(b3QuotePageReason("https://br.advfn.com/bolsa-de-valores/bovespa/banco-do-brasil-BBAS3/cotacao", [])).not.toBeNull();
	});

	it("não bloqueia o que não é cotação da B3: outro site, outra seção do site, página sem ticker", () => {
		expect(b3QuotePageReason("https://loja.example.com/tenis-pegasus", ["me avisa se baixar de 400"])).toBeNull();
		expect(b3QuotePageReason("https://www.infomoney.com.br/mercados/noticia-qualquer", ["BBAS3"])).toBeNull();
		expect(b3QuotePageReason("https://investidor10.com.br/commodities/ouro/", ["me avisa se o ouro passar de 700"])).toBeNull();
		expect(b3QuotePageReason("https://www.google.com/search?q=bbas3", [])).toBeNull();
		expect(b3QuotePageReason("não é url", ["BBAS3"])).toBeNull();
	});

	it("amplia a lista: Yahoo, Google em qualquer domínio, Fundamentus, TradingView e Investing em qualquer subdomínio", () => {
		for (const url of [
			"https://finance.yahoo.com/quote/BBAS3.SA",
			"https://www.google.com.br/finance/quote/BBAS3:BVMF",
			"https://www.google.de/finance/quote/PETR4:BVMF",
			"https://www.fundamentus.com.br/detalhes.php?papel=BBAS3",
			"https://br.tradingview.com/symbols/BMFBOVESPA-BBAS3/",
			"https://www.investing.com/equities/banco-do-brasil-sa",
			"https://uk.investing.com/equities/petrobras-pn",
			"https://br.investing.com/equities/banco-do-brasil-on",
		]) {
			expect(b3QuotePageReason(url, ["me avisa se a BBAS3 cair abaixo de R$ 15"]), url).not.toBeNull();
		}
		expect(b3QuotePageReason("https://www.google.com/search?q=bbas3", ["BBAS3 cair"])).toBeNull();
	});

	it("ticker: B3SA3 e BBAS3F (fracionário) casam; 'Fire7', 'Kindle4' sem 3 letras ou sufixo fora da lista não", () => {
		for (const text of ["B3SA3", "BBAS3F", "avisa se b3sa3 cair", "https://x/acoes/bbas3f"]) expect(mentionsB3Ticker(text), text).toBe(true);
		for (const text of ["Fire7", "tablet Fire7 da Amazon", "1234 5", "A1B27", "Mate9"]) expect(mentionsB3Ticker(text), text).toBe(false);
	});

	it("só bloqueia o PREÇO: DY, P/VP, dividendos e data com passam (a fonte quote não cobre); misturado com preço bloqueia", () => {
		const url = "https://investidor10.com.br/acoes/bbas3/";
		for (const text of ["me avisa se o DY de BBAS3 passar de 8%", "P/VP de BBAS3 abaixo de 0,8", "avisa quando BBAS3 anunciar dividendos", "data com de BBAS3", "Dividend Yield da BBAS3"]) {
			expect(b3QuotePageReason(url, [text]), text).toBeNull();
		}
		for (const text of ["me avisa se a BBAS3 cair abaixo de R$ 15", "preço da BBAS3", "cotação do Banco do Brasil BBAS3", "BBAS3 e o dividendo: avisa se o preço cair"]) {
			expect(b3QuotePageReason(url, [text]), text).not.toBeNull();
		}
	});

	it("números com sinal de menos tipográfico (U+2212) ou travessão (U+2013) são negativos", () => {
		expect(parseLocalizedNumber("\u22123,5%")).toBe(-3.5);
		expect(parseLocalizedNumber("\u201322,08%")).toBe(-22.08);
		expect(parseLocalizedNumber("R$ \u22121.234,56")).toBe(-1234.56);
		expect(isNumericPageValue("\u22123,5%")).toBe(true);
		expect(pageValuesMatch("\u221222,08%", "-22,08")).toBe(true);
	});

	it("âncora: rótulo derivado do contexto (sem o valor, números nem moeda) e conferido depois", () => {
		expect(deriveAlertAnchor("Cotação R$ 16,47 0,06%", "R$ 16,47")).toBe("cotacao");
		expect(deriveAlertAnchor("Preço atual R$ 16,47 Preço Justo R$ 0,00", "R$ 16,47")).toBe("preco atual");
		expect(deriveAlertAnchor("R$ 16,47 0,06%", "R$ 16,47")).toBeUndefined();
		expect(anchorStillNear("Cotação R$ 16,02 0,10%", "cotacao")).toBe(true);
		expect(anchorStillNear("Dividend Yield 4,14%", "cotacao")).toBe(false);
	});
});

describe("page-value em tempo linear (CodeQL)", () => {
	it("isNumericPageValue com milhares de espaços ou tabs responde rápido e sem falso positivo", () => {
		const started = performance.now();
		expect(isNumericPageValue(`R$${" ".repeat(50_000)}x`)).toBe(false);
		expect(isNumericPageValue(`0${"\t".repeat(50_000)}x`)).toBe(false);
		expect(performance.now() - started).toBeLessThan(200);
	});

	it("isNumericPageValue apara antes de testar: espaço nas pontas continua valendo", () => {
		expect(isNumericPageValue("  R$ 16,47  ")).toBe(true);
		expect(isNumericPageValue(" 16,47 % ")).toBe(true);
		expect(isNumericPageValue("   ")).toBe(false);
	});

	it("pageNumbers com vírgulas repetidas no meio de um número responde rápido", () => {
		const started = performance.now();
		pageNumbers(`1${",".repeat(50_000)}1`);
		expect(performance.now() - started).toBeLessThan(200);
		expect(pageNumbers("R$ 16,47.")).toContain(16.47);
	});
});
