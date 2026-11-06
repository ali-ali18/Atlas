import type { Search, SearchExtract, SearchHit } from "@workspace/agent";
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
