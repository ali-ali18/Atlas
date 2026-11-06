import { describe, expect, it } from "vitest";
import { duckDuckGoParams, localeToDuckRegion, parseDuckDuckGoHtml } from "./duckduckgo.js";
import { decodeEntities, stripTags } from "./html-text.js";

const FIXTURE = `
<div class="result results_links result--ad ">
  <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad=1">Anúncio</a>
</div>
<div class="result results_links web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.apple.com%2Fbr%2F&amp;rut=abc">MacBook <b>Air</b></a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Chip <b>M3</b>&#x27;s.</a>
</div>
<div class="result results_links web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexemplo.com%2Fb">Loja B</a></h2>
</div>
<div class="result web-result ">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexemplo.com%2Fb">Duplicado</a></h2>
</div>
<div class="result web-result ">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dloja.com">Anúncio embrulhado</a></h2>
</div>`;

describe("parseDuckDuckGoHtml", () => {
	it("desembrulha uddg, pula anúncios e duplicados", () => {
		expect(parseDuckDuckGoHtml(FIXTURE)).toEqual([
			{ url: "https://www.apple.com/br/", title: "MacBook Air", snippet: "Chip M3's.", source: "duckduckgo" },
			{ url: "https://exemplo.com/b", title: "Loja B", snippet: "", source: "duckduckgo" },
		]);
	});
	it("respeita o limite e aceita HTML vazio", () => {
		expect(parseDuckDuckGoHtml(FIXTURE, 1)).toHaveLength(1);
		expect(parseDuckDuckGoHtml("")).toEqual([]);
	});
});

describe("duckDuckGoParams", () => {
	it("região pelo idioma e recência", () => {
		expect(localeToDuckRegion("pt-BR")).toBe("br-pt");
		expect(localeToDuckRegion("en")).toBe("wt-wt");
		const params = duckDuckGoParams("macbook", { recency: "week" });
		expect(params.get("kl")).toBe("br-pt");
		expect(params.get("df")).toBe("w");
		expect(duckDuckGoParams("x", { recency: "forever" }).has("df")).toBe(false);
	});
});

describe("html-text", () => {
	it("decodifica entidades numéricas e nomeadas e ignora as desconhecidas", () => {
		expect(decodeEntities("&#x41;&#66;&lt;&nbsp;&foo;")).toBe("AB< &foo;");
		expect(decodeEntities("&#0;&#1114112;")).toBe("&#0;&#1114112;");
	});
	it("stripTags junta espaços", () => {
		expect(stripTags("<p>a <b>b</b>\n  c</p>")).toBe("a b c");
	});
});
