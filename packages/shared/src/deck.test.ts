import { describe, expect, it } from "vitest";
import {
	DECK_MAX_SLIDES,
	DECK_MAX_STATS,
	DECK_MAX_TABLE_ROWS,
	deckImageIds,
	parseDeckBrandColor,
	parseDeckSlides,
	parseDeckTheme,
	parseCreateFileArgs,
} from "./index.js";

const BAR = { type: "bar", x: "mes", series: [{ key: "total", label: "Total" }], data: [{ mes: "Jan", total: 10 }, { mes: "Fev", total: 20 }] };

describe("parseDeckSlides", () => {
	it("formato antigo {title, bullets} vira o layout bullets", () => {
		const out = parseDeckSlides([{ title: "Oi", bullets: ["a", " ", "b"] }]);
		expect(out).toEqual([{ layout: "bullets", title: "Oi", bullets: [{ text: "a", sub: [] }, { text: "b", sub: [] }] }]);
	});

	it("bullets aceitam sub-itens e limitam o tamanho", () => {
		const [slide] = parseDeckSlides([{ title: "T", bullets: [{ text: "pai", sub: ["x", "y"] }] }]);
		expect(slide).toMatchObject({ layout: "bullets", bullets: [{ text: "pai", sub: ["x", "y"] }] });
		expect(() => parseDeckSlides([{ title: "T", bullets: Array.from({ length: 21 }, () => "x") }])).toThrow(/too many/i);
		expect(() => parseDeckSlides([{ title: "T", bullets: [{ text: "p", sub: Array.from({ length: 7 }, () => "x") }] }])).toThrow(/too many/i);
	});

	it("layout inválido lista os válidos; título é obrigatório", () => {
		expect(() => parseDeckSlides([{ layout: "carousel", title: "x" }])).toThrow(/stats/);
		expect(() => parseDeckSlides([{ layout: "bullets", bullets: ["x"] }])).toThrow(/title/);
		expect(() => parseDeckSlides([])).toThrow(/non-empty/);
		expect(() => parseDeckSlides(Array.from({ length: DECK_MAX_SLIDES + 1 }, () => ({ title: "x" })))).toThrow(/Too many slides/);
	});

	it("stats: big_number é apelido, 1 a 4 cartões", () => {
		const [one] = parseDeckSlides([{ layout: "big_number", title: "Receita", stats: [{ value: "R$ 164 mil", label: "Faturamento" }] }]);
		expect(one).toMatchObject({ layout: "stats", stats: [{ value: "R$ 164 mil", label: "Faturamento" }] });
		const many = Array.from({ length: DECK_MAX_STATS + 1 }, (_, i) => ({ value: String(i), label: "x" }));
		expect(() => parseDeckSlides([{ layout: "stats", title: "T", stats: many }])).toThrow(/too many/i);
		expect(() => parseDeckSlides([{ layout: "stats", title: "T", stats: [{ value: "1" }] }])).toThrow(/label/);
	});

	it("chart: só bar, line, area e pie, com limite de pontos", () => {
		const [ok] = parseDeckSlides([{ layout: "chart", title: "Vendas", chart: BAR }]);
		expect(ok).toMatchObject({ layout: "chart", chart: { type: "bar" } });
		expect(() => parseDeckSlides([{ layout: "chart", title: "x", chart: { ...BAR, type: "radar", data: [{ mes: "a", total: 1 }, { mes: "b", total: 2 }, { mes: "c", total: 3 }] } }])).toThrow(/not available in slides/);
		expect(() => parseDeckSlides([{ layout: "chart", title: "x", chart: { ...BAR, data: [] } }])).toThrow(/chart/);
		const big = Array.from({ length: 41 }, (_, i) => ({ mes: `m${i}`, total: i }));
		expect(() => parseDeckSlides([{ layout: "chart", title: "x", chart: { ...BAR, data: big } }])).toThrow(/too many points/);
	});

	it("table: completa linhas curtas e recusa excesso", () => {
		const [t] = parseDeckSlides([{ layout: "table", title: "T", columns: ["A", "B"], rows: [["1"], ["2", "3"]] }]);
		expect(t).toMatchObject({ rows: [["1", ""], ["2", "3"]] });
		expect(() => parseDeckSlides([{ layout: "table", title: "T", columns: ["A"], rows: [["1", "2"]] }])).toThrow(/more cells/);
		const rows = Array.from({ length: DECK_MAX_TABLE_ROWS + 1 }, () => ["x"]);
		expect(() => parseDeckSlides([{ layout: "table", title: "T", columns: ["A"], rows }])).toThrow(/too many/i);
		expect(() => parseDeckSlides([{ layout: "table", title: "T", columns: Array.from({ length: 9 }, () => "c"), rows: [["x"]] }])).toThrow(/too many/i);
	});

	it("two_column exige duas colunas; timeline de 2 a 6 passos", () => {
		expect(() => parseDeckSlides([{ layout: "two_column", title: "T", columns: [{ bullets: ["a"] }] }])).toThrow(/at least 2/);
		expect(() => parseDeckSlides([{ layout: "timeline", title: "T", steps: [{ label: "1", title: "a" }] }])).toThrow(/at least 2/);
		const steps = Array.from({ length: 7 }, (_, i) => ({ label: String(i), title: "x" }));
		expect(() => parseDeckSlides([{ layout: "timeline", title: "T", steps }])).toThrow(/too many/i);
	});

	it("image: aceita id de anexo/artefato e recusa URL e data URI", () => {
		const [img] = parseDeckSlides([{ layout: "image", title: "Foto", image: "artifact:abc-123", caption: "Legenda" }]);
		expect(img).toMatchObject({ layout: "image", image: "abc-123", bullets: [] });
		expect(() => parseDeckSlides([{ layout: "image", title: "x", image: "https://exemplo.com/a.png" }])).toThrow(/not a URL/);
		expect(() => parseDeckSlides([{ layout: "image", title: "x", image: "data:image/png;base64,AAAA" }])).toThrow(/not a URL/);
		expect(() => parseDeckSlides([{ layout: "image", title: "x", image: "../etc/passwd" }])).toThrow(/valid image id/);
		expect(deckImageIds(parseDeckSlides([{ layout: "image", title: "a", image: "i1" }, { layout: "image", title: "b", image: "i1" }, { title: "c" }]))).toEqual(["i1"]);
	});

	it("quote e agenda; notas têm limite", () => {
		expect(parseDeckSlides([{ layout: "quote", quote: "Frase", author: "Ana" }])[0]).toMatchObject({ layout: "quote", author: "Ana" });
		expect(parseDeckSlides([{ layout: "agenda", items: ["a", "b"] }])[0]).toMatchObject({ layout: "agenda", title: "Agenda", items: ["a", "b"] });
		expect(parseDeckSlides([{ title: "T", notes: "fale devagar" }])[0]).toMatchObject({ notes: "fale devagar" });
		expect(() => parseDeckSlides([{ title: "T", notes: "x".repeat(2001) }])).toThrow(/too long/);
	});
});

describe("tema e cor da marca", () => {
	it("tema padrão clean; inválido erra", () => {
		expect(parseDeckTheme(undefined)).toBe("clean");
		expect(parseDeckTheme("Dark")).toBe("dark");
		expect(() => parseDeckTheme("neon")).toThrow(/clean, dark, corporate, vivid/);
	});
	it("brand_color normaliza hex e recusa lixo", () => {
		expect(parseDeckBrandColor("#ABC")).toBe("#aabbcc");
		expect(parseDeckBrandColor(undefined)).toBeUndefined();
		expect(() => parseDeckBrandColor("verde")).toThrow(/hex/);
	});
	it("create_file leva tema, cor e slides validados", () => {
		const out = parseCreateFileArgs({ filename: "d.pptx", theme: "vivid", brand_color: "#16A34A", slides: [{ layout: "title", title: "Oi" }] });
		expect(out).toMatchObject({ format: "pptx", theme: "vivid", brandColor: "#16a34a", slides: [{ layout: "title", title: "Oi" }] });
		expect(parseCreateFileArgs({ filename: "d.pptx", slides: [{ title: "Oi" }] }).theme).toBe("clean");
		expect(() => parseCreateFileArgs({ filename: "d.pptx", theme: "x", slides: [{ title: "Oi" }] })).toThrow(/theme/);
	});
});
