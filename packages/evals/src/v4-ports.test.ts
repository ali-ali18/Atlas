import { describe, expect, it } from "vitest";
import type { NativeFixture } from "./scenario.js";
import { createFixtureBrowser, createFixtureSearch, hitsFromSummary } from "./v4-ports.js";

const fixtures: NativeFixture[] = [
	{ tool: "web_search", result: { ok: true, summary: "Results:\n1. EcoPack Sul: R$ 1,85 por unidade. https://www.ecopacksul.test/produtos\n2. VerdePack: R$ 1,72. https://www.verdepack.test/produtos" } },
	{ tool: "web_extract", args: { url: { contains: "ecopacksul.test" } }, result: { ok: true, summary: "EcoPack Sul\nPreço: R$ 1,85." } },
	{ tool: "web_extract", args: { url: { contains: "quebrado.test" } }, result: { ok: false, summary: "timeout" } },
];

describe("fixture Search do eval do v4", () => {
	it("transforma o resumo do fixture de busca em resultados com URL", () => {
		const hits = hitsFromSummary(fixtures[0]!.result.summary);
		expect(hits.map((hit) => hit.url)).toEqual(["https://www.ecopacksul.test/produtos", "https://www.verdepack.test/produtos"]);
		expect(hits[0]!.title).toContain("EcoPack Sul");
	});

	it("resumo sem URL vira um resultado só (não perde o texto)", () => {
		expect(hitsFromSummary("Nada estruturado aqui")).toEqual([{ title: "Resultados", url: "https://search.eval.test/resultados", snippet: "Nada estruturado aqui" }]);
	});

	it("extract responde pelo fixture da URL; sem fixture ou com ok:false falha com o motivo", async () => {
		const search = createFixtureSearch(fixtures);
		expect((await search.extract("u", "https://www.ecopacksul.test/produtos")).text).toContain("R$ 1,85");
		await expect(search.extract("u", "https://outra.test/x")).rejects.toThrow(/not found/);
		await expect(search.extract("u", "https://quebrado.test/x")).rejects.toThrow("timeout");
		expect(search.extracted).toHaveLength(3);
	});

	it("busca sem fixture devolve lista vazia; com ok:false falha", async () => {
		expect(await createFixtureSearch([]).search("u", "qualquer")).toEqual([]);
		await expect(createFixtureSearch([{ tool: "web_search", result: { ok: false, summary: "fora do ar" } }]).search("u", "x")).rejects.toThrow("fora do ar");
	});
});

describe("fixture do navegador do eval do v4", () => {
	const page = (summary: string): NativeFixture[] => [{ tool: "browser_page", result: { ok: true, summary } }];
	it("sem fixture não há navegador", () => {
		expect(createFixtureBrowser(fixtures)).toBeUndefined();
	});
	it("monta a página de comentários (40 carregados de 1.000, resposta no nº 870)", async () => {
		const browser = createFixtureBrowser(page(JSON.stringify({ kind: "comments", url: "https://v.test/w", total: 1000, initial: 40, answerAt: 870, answer: "code ZZ-1" })))!;
		await browser.run("u", { kind: "browser.open", params: { url: "https://v.test/w" } });
		const map = await browser.run("u", { kind: "browser.map", params: {} });
		expect(JSON.stringify(map.data)).toContain('"declaredTotal":1000');
		expect(browser.page?.sections[1]?.all[869]).toContain("ZZ-1");
	});
	it("resumo que não é JSON ou molde desconhecido falha alto", () => {
		expect(() => createFixtureBrowser(page("não é json"))).toThrow(/JSON/);
		expect(() => createFixtureBrowser(page(JSON.stringify({ kind: "outro" })))).toThrow(/desconhecido/);
	});
});
