import { FakeShopping, productPageHtml, type Search, type SearchExtract, type SearchHit } from "@workspace/agent";
import { parseMoneyNumber } from "@workspace/shared";
import { argsMatch } from "./predicates.js";
import type { NativeFixture, Scenario } from "./scenario.js";

/**
 * Portas falsas do motor v4 no eval. `Search` responde pelos fixtures `web_search`/`web_extract` do cenário (a mesma
 * fonte do v1/v2), tanto para a mãe quanto para os ajudantes da capacidade `research`, que leem as páginas pela mesma
 * porta. Sem fixture, a leitura falha com o motivo (resultado honesto), nunca com página inventada.
 */

const HIT_LINE = /^\s*(?:\d+[.)]\s*)?(.*?)\s*(https?:\/\/\S+?)[).,;]*\s*$/;

/** Resumo de fixture `web_search` ("1. título ... https://url") → resultados. Sem linhas com URL, vira um resultado só. */
export function hitsFromSummary(summary: string): SearchHit[] {
	const hits: SearchHit[] = [];
	for (const line of summary.split("\n")) {
		const match = HIT_LINE.exec(line);
		if (!match?.[2]) continue;
		const title = (match[1] ?? "").replace(/[:\-–(\s]+$/, "").trim();
		hits.push({ title: title || match[2], url: match[2], snippet: (match[1] ?? "").trim() });
	}
	return hits.length > 0 ? hits : [{ title: "Resultados", url: "https://search.eval.test/resultados", snippet: summary }];
}

const failure = (summary: string): Error => new Error(summary || "fixture sem resultado");

export function createFixtureSearch(fixtures: readonly NativeFixture[]): Search & { readonly extracted: string[] } {
	const extracted: string[] = [];
	const find = (tool: string, args: unknown) => fixtures.find((item) => item.tool === tool && argsMatch(args, item.args));
	return {
		extracted,
		async search(_userId, query) {
			const fixture = find("web_search", { query });
			if (!fixture) return [];
			if (!fixture.result.ok) throw failure(fixture.result.summary);
			return hitsFromSummary(fixture.result.summary);
		},
		async extract(_userId, url): Promise<SearchExtract> {
			extracted.push(url);
			const fixture = find("web_extract", { url, urls: [url] });
			if (!fixture) throw new Error(`${url}: error (not found). No page is available for this address.`);
			if (!fixture.result.ok) throw failure(fixture.result.summary);
			return { url, text: fixture.result.summary };
		},
	};
}

export const fixtureSearchFor = (scenario: Scenario) => createFixtureSearch(scenario.tools.fixtures);

/**
 * Compras no eval do v4: a página de cada loja é montada A PARTIR DO FIXTURE `web_extract` do cenário (as linhas
 * "Preço:", "Entrega:", "Loja:", "Link:" e a imagem), como HTML com JSON-LD, que é o que o `product_search` lê de verdade.
 * É conversão de formato do fixture do harness, não decisão de comportamento. Frete que o fixture não declara com valor
 * (ex.: "grátis acima de R$ 199") fica SEM `shippingDetails`: o total sai "não informado", como numa página real.
 */
const labelValue = (text: string, label: RegExp): string | undefined => label.exec(text)?.[1]?.trim();

export function createFixtureShopping(fixtures: readonly NativeFixture[]): FakeShopping {
	const shopping = new FakeShopping();
	for (const fixture of fixtures) {
		if (fixture.tool !== "web_extract" || !fixture.result.ok) continue;
		const text = fixture.result.summary;
		const url = labelValue(text, /Link:\s*(https?:\/\/\S+)/i);
		const priceText = labelValue(text, /(?:Pre[cç]o|Price):\s*(?:R\$|US\$|\$|€)\s*([\d.,]+)/i);
		if (!url || !priceText) continue;
		const [firstLine = "Produto"] = text.split("\n");
		const [name = firstLine, titleStore] = firstLine.split(" | ");
		const price = parseMoneyNumber(priceText);
		if (price === null) continue;
		const oldText = labelValue(text, /\((?:de|was)\s*(?:R\$|US\$|\$|€)\s*([\d.,]+)\)/i);
		const image = labelValue(text, /(https?:\/\/\S+\.(?:jpe?g|png|webp))/i);
		const delivery = labelValue(text, /(?:Entrega|Shipping):\s*(.+)/i) ?? "";
		const currency = /R\$/.test(text) ? "BRL" : /€/.test(text) ? "EUR" : "USD";
		const shipping = /(?:frete gr[aá]tis|free)$/i.test(delivery) ? 0 : parseMoneyNumber(/(?:frete )?(?:R\$|US\$|\$|€)\s*([\d.,]+)/i.exec(delivery)?.[1]);
		shopping.html.set(
			url,
			productPageHtml({
				name: name.trim(),
				price,
				currency,
				merchant: labelValue(text, /Loja:\s*(.+)/i) ?? titleStore?.trim() ?? new URL(url).hostname,
				...(oldText && parseMoneyNumber(oldText) !== null && { oldPrice: parseMoneyNumber(oldText)! }),
				...(image && { images: [image] }),
				...(shipping !== null && shipping !== undefined && { shipping }),
				...(/dispon[ií]vel/i.test(text) && { availability: "InStock" }),
			}),
		);
	}
	return shopping;
}
