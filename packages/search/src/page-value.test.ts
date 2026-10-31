import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { findPageValue, locatePageValue } from "./page-value.js";

/** Caso real reduzido: a página do BBAS3 no Investidor10 tem uma faixa de commodities com "Cotação: R$ ..." antes do preço da ação. */
const strip = ["Ouro|R$ 612,30", "Milho|R$ 68,15", "Café|R$ 1.284,50", "Soja|R$ 131,90", "Boi gordo|R$ 312,40", "Dólar|R$ 5,47"]
	.map((row) => {
		const [name, price] = row.split("|");
		return `<div class="commodity"><span class="commodity-name">${name}</span><span class="commodity-quote">Cotação: ${price}</span></div>`;
	})
	.join("");

const INVESTIDOR10 = `<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><title>BBAS3 Banco do Brasil cotação R$ 16,47</title>
<meta property="og:description" content="Cotação BBAS3 R$ 16,47 hoje">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Investidor10"}</script>
<script>window.__STATE__={"quote":"16,47","series":[16.47,16.5]};</script><style>.value{color:red}</style></head>
<body>
<div class="commodities-bar">${strip}</div>
<main id="main-content">
<h1>BBAS3 <small>Banco do Brasil</small></h1>
<div class="_card cotacao"><div class="_card-header"><span class="title">Cotação BBAS3</span></div><div class="_card-body"><div><span class="value">R$ 16,47</span></div></div></div>
<div class="_card val"><div class="_card-header"><span class="title">Variação (12M)</span></div><div class="_card-body"><div><span class="value">-8,10%</span></div></div></div>
<div class="_card dy"><div class="_card-header"><span class="title">Dividend Yield</span></div><div class="_card-body"><div><span class="value">9,30%</span></div></div></div>
<p class="summary">A cotação atual de BBAS3 é R$ 16,47, com variação de -0,60% no dia.</p>
<table class="indicators"><tr><td>Mínimo 52 semanas</td><td>R$ 15,10</td></tr><tr><td>Máximo 52 semanas</td><td>R$ 28,17</td></tr></table>
<div class="css-9a8b7c"><span class="css-77ffee">R$ 16,47</span></div>
</main></body></html>`;

/** Loja com várias variantes do mesmo modelo, preço da variante escolhida em meta, JSON-LD e atributos data-sku. */
const STORE = `<!doctype html><html><head><title>Smartphone Galaxy X</title>
<meta property="product:price:amount" content="3299.00"><meta property="product:price:currency" content="BRL">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Smartphone Galaxy X","offers":[
{"@type":"Offer","name":"Galaxy X 128 GB","price":"2799.00","priceCurrency":"BRL"},
{"@type":"Offer","name":"Galaxy X 256 GB","price":"3299.00","priceCurrency":"BRL"},
{"@type":"Offer","name":"Galaxy X 512 GB","price":"3899.00","priceCurrency":"BRL"}]}</script></head>
<body><h1 class="product-title">Smartphone Galaxy X</h1>
<ul class="variants">
<li class="variant" data-sku="GX-128"><h3 class="variant-name">Galaxy X 128 GB</h3><span class="price">R$ 2.799,00</span></li>
<li class="variant" data-sku="GX-256"><h3 class="variant-name">Galaxy X 256 GB</h3><span class="price">R$ 3.299,00</span></li>
<li class="variant" data-sku="GX-512"><h3 class="variant-name">Galaxy X 512 GB</h3><span class="price">R$ 3.899,00</span></li>
</ul>
<div class="buy-box"><span class="buy-price" itemprop="price" content="3299.00">R$ 3.299,00</span></div>
</body></html>`;

/** Mesma loja, mas as variantes não se distinguem por nenhum atributo: só dá para apontar por posição. */
const STORE_ANONYMOUS = `<html><body><ul class="variants">
<li class="variant"><h3>Galaxy X 128 GB</h3><span class="price">R$ 2.799,00</span></li>
<li class="variant"><h3>Galaxy X 256 GB</h3><span class="price">R$ 3.299,00</span></li>
</ul></body></html>`;

/** Lê o valor como a regra leria (primeiro elemento do seletor, texto ou atributo). */
function readLikeTheRule(html: string, extract: { selector: string; attribute?: string }): string {
	const { document } = parseHTML(html);
	const node = document.querySelectorAll(extract.selector)[0] as Element | undefined;
	return (extract.attribute ? node?.getAttribute(extract.attribute) : node?.textContent)?.replace(/\s+/g, " ").trim() ?? "";
}

describe("localizar o valor na página: caso Investidor10 (BBAS3)", () => {
	const result = locatePageValue(INVESTIDOR10, "16,47", "BBAS3");

	it("o chute de regex 'Cotação R$' leria o ouro (a armadilha), mas o seletor proposto lê a ação", () => {
		const text = INVESTIDOR10.replace(/<[^>]*>/g, " ");
		expect(/Cotação:?\s*R\$\s*([\d.,]+)/.exec(text)?.[1]).toBe("612,30");
		const css = result.candidates.find((candidate) => candidate.extract?.selector.includes("cotacao"));
		expect(css).toBeDefined();
		expect(css!.extract).toEqual({ kind: "css", selector: "div._card.cotacao span.value" });
		expect(readLikeTheRule(INVESTIDOR10, css!.extract!)).toBe("R$ 16,47");
	});

	it("o seletor casa exatamente 1 elemento (span.value sozinho casa 3 cards) e não usa índice nem classe gerada", () => {
		const { document } = parseHTML(INVESTIDOR10);
		expect(document.querySelectorAll("span.value").length).toBe(3);
		for (const candidate of result.candidates) {
			if (!candidate.extract) continue;
			expect(document.querySelectorAll(candidate.extract.selector).length, candidate.extract.selector).toBe(1);
			expect(candidate.extract.selector).not.toMatch(/nth-|:first|:last|css-|sc-/);
		}
	});

	it("cada candidata traz leitura, contexto limpo e tipo; o contexto fala do que a página mostra", () => {
		const css = result.candidates.find((candidate) => candidate.extract?.selector === "div._card.cotacao span.value")!;
		expect(css).toMatchObject({ type: "css", reading: "R$ 16,47", nearMatch: true });
		expect(css.context).toContain("Cotação BBAS3");
		expect(css.context).toContain("R$ 16,47");
		expect(css.context).not.toMatch(/[<>]/);
		expect(css.context.length).toBeLessThanOrEqual(160);
	});

	it("ocorrência cujo primeiro número é outro (o '3' de BBAS3 no texto corrido) não vira candidata", () => {
		expect(result.skipped).toBeGreaterThanOrEqual(1);
		expect(result.candidates.every((candidate) => !candidate.context.startsWith("A cotação atual de BBAS3"))).toBe(true);
	});

	it("elemento só com classes geradas aparece com nota, sem seletor, e fica depois dos que têm seletor", () => {
		const last = result.candidates[result.candidates.length - 1]!;
		expect(last.extract).toBeNull();
		expect(last.note).toMatch(/no stable selector/);
		expect(result.candidates[0]!.extract).not.toBeNull();
	});

	it("não lê script, estilo nem head: o 16,47 do JSON da página e do og:description não entra", () => {
		const contexts = result.candidates.map((candidate) => candidate.context).join("\n");
		expect(contexts).not.toMatch(/__STATE__|og:description|color:red/);
		expect(result.candidates.length).toBe(2);
	});

	it("valor que não está na página: nenhuma candidata", () => {
		expect(locatePageValue(INVESTIDOR10, "99,99").candidates).toEqual([]);
	});
});

describe("localizar o valor na página: loja com vários modelos", () => {
	const result = locatePageValue(STORE, "3.299,00", "256 GB");

	it("estruturado primeiro (meta/itemprop com seletor), depois o visível com o modelo certo, depois JSON-LD sem seletor", () => {
		const types = result.candidates.map((candidate) => candidate.type);
		expect(types[0]).toBe("structured");
		expect(result.candidates[0]!.extract).toMatchObject({ kind: "css", attribute: "content" });
		const visible = result.candidates.find((candidate) => candidate.extract?.selector === 'li[data-sku="GX-256"] span.price');
		expect(visible).toBeDefined();
		expect(visible).toMatchObject({ type: "css", reading: "R$ 3.299,00", nearMatch: true });
		expect(visible!.context).toContain("Galaxy X 256 GB");
		expect(result.candidates[result.candidates.length - 1]).toMatchObject({ type: "structured", extract: null });
	});

	it("itemprop=price com content vira atributo, não texto; meta de preço também", () => {
		const extracts = result.candidates.map((candidate) => candidate.extract);
		expect(extracts).toContainEqual({ kind: "css", selector: 'span[itemprop="price"]', attribute: "content" });
		expect(extracts).toContainEqual({ kind: "css", selector: 'meta[property="product:price:amount"]', attribute: "content" });
		for (const extract of extracts) if (extract) expect(readLikeTheRule(STORE, extract)).toMatch(/3299(\.00)?|R\$ 3\.299,00/);
	});

	it("o seletor aponta o modelo pedido pelo atributo (sku), nunca por posição: o preço de outro modelo não é lido", () => {
		const other = locatePageValue(STORE, "2.799,00", "128 GB").candidates.find((candidate) => candidate.type === "css")!;
		expect(other.extract!.selector).toBe('li[data-sku="GX-128"] span.price');
		expect(readLikeTheRule(STORE, other.extract!)).toBe("R$ 2.799,00");
	});

	it("com near, o JSON-LD do modelo pedido é o marcado como próximo; o de outro modelo não", () => {
		const jsonLd = locatePageValue(STORE, "3.299,00", "256 GB").candidates.find((candidate) => candidate.context.startsWith("JSON-LD"))!;
		expect(jsonLd.nearMatch).toBe(true);
		expect(jsonLd.note).toMatch(/JSON-LD/);
		const wrong = locatePageValue(STORE, "3.299,00", "512 GB").candidates.find((candidate) => candidate.context.startsWith("JSON-LD"))!;
		expect(wrong.nearMatch).toBe(false);
	});

	it("o mesmo número escrito em outro formato (3299, R$ 3.299, 3299.00) acha as mesmas ocorrências", () => {
		const base = result.candidates.map((candidate) => candidate.extract?.selector).sort();
		for (const value of ["3299", "R$ 3.299", "3299.00"]) {
			expect(locatePageValue(STORE, value, "256 GB").candidates.map((candidate) => candidate.extract?.selector).sort(), value).toEqual(base);
		}
	});

	it("variantes sem atributo que as distinga: não inventa posição, devolve a ocorrência com nota", () => {
		const anonymous = locatePageValue(STORE_ANONYMOUS, "3.299,00", "256 GB");
		expect(anonymous.candidates).toHaveLength(1);
		expect(anonymous.candidates[0]).toMatchObject({ extract: null, nearMatch: true });
		expect(anonymous.candidates[0]!.note).toMatch(/no stable selector/);
	});
});

/** Trecho REAL da página do BBAS3 no Investidor10 (ícones SVG removidos): faixa de commodities, card "cotacao", caixa de preço atual e o parágrafo do FAQ com .livePrice. */
const INVESTIDOR10_REAL = `<!DOCTYPE html><html lang="pt-br"><head><title>BBAS3: Cotação</title>
<script type="application/ld+json">{
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
        {
            "@type": "Question",
            "name": "Qual a cotação de Banco do Brasil (BBAS3) hoje?",
            "acceptedAnswer": {
                "@type": "Answer",
                "text": "A cotação de Banco do Brasil (BBAS3) hoje está em R$ 16,47, com uma variação de -22,08% em relação aos últimos 12 meses. A cotação de Banco do Brasil (BBAS3) iniciou o ano negociando na casa dos R$ 21,92 e hoje está em R$ 16,47. Acompanhe o gráfico de cotação em tempo real, a cotação histórica de Banco do Brasil (BBAS3) e dados de ações do Ibovespa e mercados internacionais."
            }
        },
        {
            "@type": "Question",
            "name": "Quando Banco do Brasil (BBAS3) paga dividendos?",
            "acceptedAnswer": {
                "@type": "Answer",
                "text": "Banco do Brasil (BBAS3) distribuiu dividendos no último ano, nos meses de março, junho e dezembro totalizando R$ 1,18. O Dividend Yield referente aos últimos 12 meses é de 4,14%."
            }
        },
        {
            "@type": "Question",
            "name": "Banco do Brasil (BBAS3) vale a pena?",
            "acceptedAnswer": {
                "@type": "Answer",
                "text": "Atualmente, Banco do Brasil (BBAS3) está cotada a R$ 16,47. No último ano, a ação apresentou uma variação de -22,08% em sua cotação e distribuiu R$ 1,18 em dividendos, resultando em um Dividend Yield de 4,14%. O retorno total ao acionista foi de -22,08%.É importante lembrar que rentabilidade passada não garante resultados futuros. Isso não deve ser visto como uma recomendação de investimento."
            }
        },
        {
            "@type": "Question",
            "name": "Como comprar ações de Banco do Brasil (BBAS3)?",
            "acceptedAnswer": {
                "@type": "Answer",
                "text": "Investir em ações de Banco do Brasil (BBAS3) é simples. Abra uma conta em uma corretora de valores, transfira dinheiro e acesse o home broker. Procure pelo ticker BBAS3, defina a quantidade de ações e envie a ordem de compra. Após a liquidação, as ações farão parte do seu portfólio."
            }
        },
        {
            "@type": "Question",
            "name": "Quanto rende 100 ações de Banco do Brasil (BBAS3) hoje?",
            "acceptedAnswer": {
                "@type": "Answer",
                "text": "A rentabilidade de Banco do Brasil (BBAS3) foi de -28,61% no último mês, -22,08% no último ano, 61,01% nos últimos cinco anos e 101,61% ao longo da última década (já considerando valorização e dividendos).Nos últimos 12 meses, a empresa pagou um total de R$ 1,18 em dividendos, resultando em um Dividend Yield de 4,14%.Se você quisesse comprar 100 ações de Banco do Brasil hoje, o investimento total seria de R$ 1.647,00, com base na cotação atual de R$ 16,47.Caso o desempenho passado de Banco do Brasil se repetisse, o retorno do seu investimento seria de: Em 5 anos: 61,01% (ou, R$ 2.651,83)Em 10 anos: 101,61% (ou, R$ 3.320,52) É importante lembrar que rentabilidade passada não garante resultados futuros. Isso não deve ser visto como uma recomendação de investimento."
            }
        }
    ]
}</script>
</head><body>
<a href="https://investidor10.com.br/commodities/boi-gordo/" class="menu-v2__card card-ranking-menu" data-type="commodities">
  <div class="menu-v2__card-header"><span class="menu-v2__card-title">Boi Gordo</span></div>
  <div class="menu-v2__commodities-cotacao"><span class="menu-v2__commodities-cotacao-label">Cotação:</span>
    <span class="menu-v2__commodities-cotacao-value">R$ 669,66</span></div></a>
<a href="https://investidor10.com.br/commodities/ouro/" class="menu-v2__card card-ranking-menu" data-type="commodities">
  <div class="menu-v2__card-header"><span class="menu-v2__card-title">Ouro</span></div>
  <div class="menu-v2__commodities-cotacao"><span class="menu-v2__commodities-cotacao-label">Cotação:</span>
    <span class="menu-v2__commodities-cotacao-value">R$ 612,30</span></div></a>
<section class="section-sectors ticker-content-section"><div class="container">
<section id="cards-ticker" class="cards-ticker--stock">
    <div class="_card cotacao">
        <div class="_card-header"><div><span title="Cotação">Cotação</span></div></div>
        <div class="_card-body"><div>
            <span class="value">R$ 16,47</span>
            <span class="daily-variation-badge daily-variation-badge--positive">0,06%</span>
        </div></div>
    </div>
    <div class="_card val">
        <div class="_card-header"><div><span title="Variação (12M)">Variação (12M)</span></div></div>
        <div class="_card-body"><div><span class="value">-22,08%</span></div></div>
    </div>
</section>
<div id="graham-component"><div class="presentation"><div class="presentation-box">
    <div class="box current-price"><p class="title">Preço atual</p><span class="value">R$ 16,47</span></div>
    <div class="box fair-price"><p class="title">Preço Justo</p><span class="value">R$ 0,00</span></div>
</div></div></div>
<div class="container-answer-question active" rel="1">
    <p>A cotação de <strong>Banco do Brasil (BBAS3)</strong> hoje está em <strong><span class='livePrice'>R$ 16,47</span></strong>, com uma variação de <strong>-22,08%</strong> em relação aos últimos 12 meses.</p>
</div>
<div class="container-answer-question" rel="3">
    <p>Atualmente, <strong>Banco do Brasil (BBAS3)</strong> está cotada a <span class='livePrice'><strong>R$ 16,47</strong></span>. No último ano, a ação apresentou uma variação de -22,08%.</p>
</div>
</div></section></body></html>`;

describe("regressão: trecho real do Investidor10 (BBAS3)", () => {
	const result = locatePageValue(INVESTIDOR10_REAL, "16,47", "BBAS3");

	it("a fixture tem cerca de 5 KB", () => {
		expect(INVESTIDOR10_REAL.length).toBeGreaterThan(3500);
		expect(INVESTIDOR10_REAL.length).toBeLessThan(6500);
	});

	it("o 1º candidato é o card de cotação (não o parágrafo com .livePrice, que tem BBAS3 por perto)", () => {
		const first = result.candidates[0]!;
		expect(first.reading).toBe("R$ 16,47");
		expect(first.context).toContain("Cotação");
		expect(first.extract!.selector).toMatch(/span\.value$/);
		expect(readLikeTheRule(INVESTIDOR10_REAL, first.extract!)).toBe("R$ 16,47");
		const { document } = parseHTML(INVESTIDOR10_REAL);
		expect(document.querySelector(first.extract!.selector)?.closest("._card")?.className).toContain("cotacao");
	});

	it("as ocorrências em prosa (.livePrice dentro de <p>) ficam depois das de elemento só com o valor", () => {
		const selectors = result.candidates.map((candidate) => candidate.extract?.selector ?? "");
		const firstProse = selectors.findIndex((selector) => selector.includes("livePrice"));
		const lastTight = selectors.map((selector) => selector.endsWith("span.value")).lastIndexOf(true);
		expect(firstProse === -1 || firstProse > lastTight).toBe(true);
	});

	it("a faixa de commodities nunca vira candidata (são outros números)", () => {
		expect(result.candidates.every((candidate) => !/commodit|669|612/.test(`${candidate.context} ${candidate.extract?.selector ?? ""}`))).toBe(true);
	});
});

describe("localizar: orçamento de tempo e seletor com atributo", () => {
	it("estourou o orçamento: devolve o que tem, sem lançar e sem montar seletor", () => {
		const result = locatePageValue(INVESTIDOR10_REAL, "16,47", "BBAS3", { budgetMs: 0 });
		expect(result.candidates.length).toBeGreaterThan(0);
		expect(result.candidates.every((candidate) => candidate.extract === null)).toBe(true);
		expect(result.candidates[0]!.note).toMatch(/time budget/);
	});

	it("valor de atributo com espaço não entra no seletor (só [\\w-]); sem espaço entra", () => {
		const spaced = `<html><body><ul><li class="v" data-variant="plano 256"><span class="price">R$ 3.299,00</span></li><li class="v" data-variant="plano 128"><span class="price">R$ 2.799,00</span></li></ul></body></html>`;
		const noSpace = spaced.replace("plano 256", "plano-256").replace("plano 128", "plano-128");
		const withSpace = locatePageValue(spaced, "3.299,00").candidates[0]!;
		expect(withSpace.extract).toBeNull();
		expect(locatePageValue(noSpace, "3.299,00").candidates[0]!.extract!.selector).toBe('li[data-variant="plano-256"] span.price');
	});
});

describe("localizar o valor: limites", () => {
	it("no máximo 10 candidatas, e diz quantas ocorrências a página tem", () => {
		const html = `<html><body>${Array.from({ length: 25 }, (_, i) => `<div class="row-${["a", "b", "c", "d", "e"][i % 5]}"><span class="p${["x", "y", "z"][i % 3]}">R$ 9,90</span></div>`).join("")}</body></html>`;
		const result = locatePageValue(html, "9,90");
		expect(result.candidates.length).toBeLessThanOrEqual(10);
	});

	it("valor em texto (não número) é achado pelo texto, sem acento nem caixa", () => {
		const html = `<html><body><p class="stock-label">Indisponível no momento</p></body></html>`;
		const result = locatePageValue(html, "indisponivel");
		expect(result.candidates[0]).toMatchObject({ type: "css", extract: { kind: "css", selector: "p.stock-label" } });
	});

	it("preço partido em vários elementos (R$ / 16 / ,47) acha o pai que o junta", () => {
		const html = `<html><body><div class="price-box"><span>R$</span><span>16</span><span>,47</span></div></body></html>`;
		expect(locatePageValue(html, "16,47").candidates[0]).toMatchObject({ extract: { kind: "css", selector: "div.price-box" }, reading: "R$16,47" });
	});

	it("elemento escondido não conta", () => {
		const html = `<html><body><div class="old" hidden>R$ 5,00</div><div class="gone" style="display:none">R$ 5,00</div></body></html>`;
		expect(locatePageValue(html, "5,00").candidates).toEqual([]);
	});

	it("HTML quebrado não lança", () => {
		expect(() => locatePageValue("<div><span>R$ 16,47<<<</div", "16,47")).not.toThrow();
		expect(() => locatePageValue("", "16,47")).not.toThrow();
	});
});

describe("findPageValue: busca segura e falhas honestas", () => {
	const lookupPublic = async () => ["93.184.216.34"];
	const pageFetch = (body: string, contentType = "text/html; charset=utf-8", status = 200) =>
		(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
			return new Response(body, { status, headers: { "content-type": contentType } });
		}) as never;

	it("busca a página pelo leitor dos alertas e devolve as ocorrências", async () => {
		const result = await findPageValue("https://loja.example.com/galaxy-x", { value: "3.299,00", near: "256 GB" }, { fetchFn: pageFetch(STORE), lookupFn: lookupPublic });
		expect(result).toMatchObject({ ok: true, host: "loja.example.com" });
		if (result.ok) expect(result.candidates.length).toBeGreaterThan(1);
	});

	it("SSRF: endereço interno é bloqueado antes de qualquer busca", async () => {
		let called = false;
		const fetchFn = (async () => ((called = true), new Response("x"))) as never;
		for (const url of ["http://127.0.0.1/admin", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/", "file:///etc/passwd"]) {
			const result = await findPageValue(url, { value: "1" }, { fetchFn, lookupFn: lookupPublic });
			expect(result, url).toMatchObject({ ok: false, code: "blocked" });
		}
		expect(called).toBe(false);
	});

	it("DNS que aponta para rede privada também é bloqueado", async () => {
		const result = await findPageValue("https://intranet.example.com/p", { value: "1" }, { fetchFn: pageFetch(STORE), lookupFn: async () => ["10.1.2.3"] });
		expect(result).toMatchObject({ ok: false, code: "blocked" });
	});

	it("página grande demais (5 MB) é erro, nunca leitura parcial", async () => {
		const result = await findPageValue("https://loja.example.com/p", { value: "1" }, { fetchFn: pageFetch("x".repeat(200)), lookupFn: lookupPublic, maxBytes: 100 });
		expect(result).toMatchObject({ ok: false, code: "too_large" });
	});

	it("HTTP de erro e valor ausente viram falha com motivo", async () => {
		expect(await findPageValue("https://loja.example.com/p", { value: "1" }, { fetchFn: pageFetch("nope", "text/html", 403), lookupFn: lookupPublic })).toMatchObject({ ok: false, code: "http" });
		expect(await findPageValue("https://loja.example.com/p", { value: "99,99" }, { fetchFn: pageFetch(STORE), lookupFn: lookupPublic })).toMatchObject({ ok: false, code: "not_found", reason: "valor não encontrado na página" });
	});

	it("endereço que devolve JSON manda usar jsonpath em vez de procurar seletor", async () => {
		const result = await findPageValue("https://api.example.com/p", { value: "16,47" }, { fetchFn: pageFetch('{"price":16.47}', "application/json"), lookupFn: lookupPublic });
		expect(result).toMatchObject({ ok: false, code: "parse" });
		if (!result.ok) expect(result.reason).toMatch(/jsonpath/);
	});

	it("o valor só aparece depois do primeiro número do elemento: diz isso em vez de 'não encontrado'", async () => {
		const html = `<html><body><p>BBAS3 cotação R$ 16,47</p></body></html>`;
		const result = await findPageValue("https://loja.example.com/p", { value: "16,47" }, { fetchFn: pageFetch(html), lookupFn: lookupPublic });
		expect(result).toMatchObject({ ok: false, code: "not_found" });
		if (!result.ok) expect(result.reason).toMatch(/primeiro número/);
	});
});
