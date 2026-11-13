import { describe, expect, it } from "vitest";
import { parseDeckSlides } from "@workspace/shared";
import { estimateLines, estimateTextHeight, formatDeckWarnings, lintDeck } from "./lint.js";

const LONG = "Esta frase longa descreve em detalhes o cenário completo do mercado e das metas do próximo trimestre";

describe("estimativa de texto", () => {
	it("conta linhas por palavra e parágrafo", () => {
		expect(estimateLines("curto", 5, 18)).toBe(1);
		expect(estimateLines("a\nb\nc", 5, 18)).toBe(3);
		// 18 pt em 3 pol.: ~16 caracteres por linha
		expect(estimateLines("uma duas tres quatro cinco seis sete oito", 3, 18)).toBe(2);
		// palavra maior que a linha quebra no meio
		expect(estimateLines("x".repeat(100), 3, 18)).toBe(5);
		expect(estimateTextHeight("a", 5, 20)).toBeCloseTo((20 * 1.2) / 72);
	});
});

describe("lintDeck", () => {
	it("deck enxuto não gera aviso", () => {
		const slides = parseDeckSlides([
			{ layout: "title", title: "Vendas de outubro", subtitle: "Resumo" },
			{ layout: "bullets", title: "Decisões", bullets: ["Comprar substrato", "Definir meta de novembro", "Revisar frete"] },
			{ layout: "stats", title: "Em números", stats: [{ value: "R$ 164 mil", label: "Faturamento", detail: "+11%" }] },
			{ layout: "table", title: "Top", columns: ["Produto", "Receita"], rows: [["Adubo", "24.720"], ["Semente", "9.700"]] },
			{ layout: "free", elements: [{ type: "text", x: 1, y: 1, w: 6, h: 1, text: "Pitch", size: 40, bold: true }, { type: "text", x: 1, y: 2.5, w: 6, h: 1.5, text: "Menos tempo em planilha.", size: 24 }] },
		]);
		expect(lintDeck(slides)).toEqual([]);
	});

	it("bullets demais estouram o corpo do slide, com a conta no aviso", () => {
		const bullets = Array.from({ length: 10 }, () => `${LONG}. ${LONG}`);
		const warnings = lintDeck(parseDeckSlides([{ layout: "bullets", title: "Muito texto", bullets }]));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({ slide: 1 });
		expect(warnings[0]!.message).toMatch(/bullets: the text needs about \d+\.\d in at \d+ pt but only 5\.0 in fit/);
	});

	it("título longo, tabela com células longas e KPI comprido", () => {
		const slides = parseDeckSlides([
			{ layout: "bullets", title: "T".repeat(80), bullets: ["a"] },
			{ layout: "table", title: "Tabela", columns: ["A", "B", "C", "D"], rows: Array.from({ length: 8 }, () => [LONG, LONG, LONG, LONG]) },
			{ layout: "stats", title: "KPIs", stats: [{ value: "R$ 1.234.567.890", label: "Faturamento" }] },
		]);
		const messages = lintDeck(slides).map((w) => `${w.slide}:${w.message}`);
		expect(messages.some((m) => m.startsWith("1:") && /80 characters/.test(m))).toBe(true);
		expect(messages.some((m) => m.startsWith("2:") && /table needs/.test(m))).toBe(true);
		expect(messages.some((m) => m.startsWith("3:") && /KPI 1 value/.test(m))).toBe(true);
	});

	it("layout livre: texto estoura a caixa, sobreposição, letra pequena e palavras demais", () => {
		const slides = parseDeckSlides([
			{
				layout: "free",
				elements: [
					{ type: "text", x: 1, y: 1, w: 3, h: 0.6, text: LONG + ". " + LONG, size: 24 },
					{ type: "text", x: 1, y: 3, w: 4, h: 1, text: "Primeiro bloco", size: 20 },
					{ type: "text", x: 2, y: 3.2, w: 4, h: 1, text: "Segundo bloco", size: 20 },
					{ type: "text", x: 1, y: 6, w: 4, h: 0.4, text: "nota de rodapé", size: 9 },
				],
			},
			{ layout: "free", elements: [{ type: "text", x: 0.5, y: 0.5, w: 12, h: 6.5, text: Array.from({ length: 150 }, () => "palavra").join(" "), size: 14 }] },
		]);
		const first = lintDeck(slides).filter((w) => w.slide === 1).map((w) => w.message);
		expect(first.some((m) => /^element 1 .*needs about [\d.]+ in at 24 pt but the box is 0.6 in high/.test(m))).toBe(true);
		expect(first.some((m) => /elements 2 and 3 overlap/.test(m))).toBe(true);
		expect(first.some((m) => /1 text box uses under 12 pt/.test(m))).toBe(true);
		expect(lintDeck(slides).some((w) => w.slide === 2 && /150 words/.test(w.message))).toBe(true);
	});

	it("contraste: texto claro no fundo claro, e texto sobre forma colorida", () => {
		const slides = parseDeckSlides([
			{
				layout: "free",
				elements: [
					{ type: "text", x: 1, y: 1, w: 5, h: 1, text: "Quase invisível", size: 28, color: "#f1f5f9" },
					{ type: "shape", shape: "rect", x: 1, y: 3, w: 4, h: 2, fill: "#1b4332" },
					{ type: "text", x: 1.2, y: 3.2, w: 3.6, h: 1, text: "Escuro no escuro", size: 24, color: "#222222" },
					{ type: "text", x: 6, y: 3.2, w: 3, h: 1, text: "Claro no claro?", size: 24, color: "#ffffff" },
				],
			},
			{ layout: "free", background: "#0b132b", elements: [{ type: "text", x: 1, y: 1, w: 5, h: 1, text: "Texto do tema", size: 28 }] },
		]);
		const warnings = lintDeck(slides);
		const s1 = warnings.filter((w) => w.slide === 1).map((w) => w.message);
		expect(s1.some((m) => /Quase invisível.*low contrast/.test(m))).toBe(true);
		expect(s1.some((m) => /Escuro no escuro.*low contrast/.test(m))).toBe(true);
		expect(s1.some((m) => /Claro no claro/.test(m))).toBe(true);
		// o texto do tema se adapta ao fundo escuro: sem aviso
		expect(warnings.filter((w) => w.slide === 2)).toEqual([]);
	});

	it("foto de fundo sem véu ou com véu fraco avisa; o padrão não", () => {
		const bg = (scrim?: unknown) => ({ layout: "title", title: "Capa", background: { image: "bg", ...(scrim === undefined ? {} : { scrim }) } });
		const slides = parseDeckSlides([bg(), bg(false), bg({ color: "#000", opacity: 0.1 })]);
		const warnings = lintDeck(slides);
		expect(warnings.map((w) => w.slide)).toEqual([2, 3]);
		expect(warnings[0]!.message).toMatch(/without a scrim/);
		expect(warnings[1]!.message).toMatch(/only 10% opaque/);
	});

	it("formatDeckWarnings resume e orienta a corrigir", () => {
		expect(formatDeckWarnings([])).toBe("");
		const many = Array.from({ length: 15 }, (_, i) => ({ slide: i + 1, message: "x" }));
		const text = formatDeckWarnings(many, 12);
		expect(text).toContain("15 issues");
		expect(text).toContain("and 3 more");
		expect(text).toContain("create_file again with the same filename");
	});
});
