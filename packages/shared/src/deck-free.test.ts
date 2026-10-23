import { describe, expect, it } from "vitest";
import { DECK_FREE_MAX_ELEMENTS, DECK_ICON_NAMES, deckImageIds, parseCreateFileArgs, parseDeckSlides, parseDeckTemplateId } from "./index.js";

const text = (extra: Record<string, unknown> = {}) => ({ type: "text", x: 1, y: 1, w: 4, h: 1, text: "Olá", ...extra });

describe("layout free", () => {
	it("aceita elementos de todos os tipos e normaliza cores, defaults e unidades", () => {
		const [slide] = parseDeckSlides([
			{
				layout: "free",
				name: "Problema",
				elements: [
					text({ size: "32", bold: true, color: "#ABC", align: "center", valign: "middle", font: "heading" }),
					{ type: "shape", shape: "rounded_rect", x: 1, y: 2, w: 3, h: 2, fill: "surface", stroke: "#112233", stroke_width: 1.5, opacity: 0.5, text: "KPI", text_color: "text" },
					{ type: "shape", shape: "arrow", x: 5, y: 3, w: 2, h: 0, stroke: "accent" },
					{ type: "image", image: "attachment:img-1", x: 8, y: 1, w: 4, h: 3, fit: "cover" },
					{ type: "icon", name: "Rocket", x: 1, y: 5, w: 1, h: 1, color: "accent2" },
					{ type: "chart", x: 1, y: 3, w: 6, h: 3, chart: { type: "bar", x: "m", series: [{ key: "v", label: "V" }], data: [{ m: "a", v: 1 }, { m: "b", v: 2 }] } },
					{ type: "table", x: 7, y: 3, w: 5, h: 2, columns: ["A", "B"], rows: [["1"], ["2", "3"]] },
				],
			},
		]);
		expect(slide).toMatchObject({ layout: "free", name: "Problema" });
		if (slide!.layout !== "free") throw new Error("layout");
		const [t, shape, arrow, image, icon, chart, table] = slide!.elements;
		expect(t).toMatchObject({ type: "text", size: 32, color: "#aabbcc", align: "center", valign: "middle", font: "heading", bold: true });
		expect(shape).toMatchObject({ shape: "rounded_rect", fill: "surface", stroke: "#112233", strokeWidth: 1.5, opacity: 0.5, textColor: "text" });
		expect(arrow).toMatchObject({ shape: "arrow", stroke: "accent", w: 2, h: 0 });
		expect(image).toMatchObject({ image: "img-1", fit: "cover" });
		expect(icon).toMatchObject({ name: "rocket", color: "accent2" });
		expect(chart).toMatchObject({ type: "chart" });
		expect(table).toMatchObject({ rows: [["1", ""], ["2", "3"]] });
	});

	it("recusa elemento fora da página com a conta no erro", () => {
		expect(() => parseDeckSlides([{ layout: "free", elements: [text({ x: 10, w: 4 })] }])).toThrow(/falls outside the 13.333 x 7.5/);
		expect(() => parseDeckSlides([{ layout: "free", elements: [text({ y: 7, h: 1 })] }])).toThrow(/outside/);
		expect(() => parseDeckSlides([{ layout: "free", elements: [text({ x: -1 })] }])).toThrow(/x must be between/);
		expect(() => parseDeckSlides([{ layout: "free", elements: [text({ w: 0 })] }])).toThrow(/greater than 0/);
		// forma decorativa pode sangrar na borda (círculo parcial), mas não ficar toda fora nem passar de 3 pol.
		expect(() => parseDeckSlides([{ layout: "free", elements: [{ type: "shape", shape: "circle", x: 9.4, y: -1.2, w: 5.2, h: 5.2, fill: "accent" }] }])).not.toThrow();
		expect(() => parseDeckSlides([{ layout: "free", elements: [{ type: "shape", shape: "circle", x: 9.4, y: -4, w: 5.2, h: 5.2, fill: "accent" }] }])).toThrow(/y must be between -3 and/);
		expect(() => parseDeckSlides([{ layout: "free", elements: [{ type: "shape", shape: "rect", x: -3, y: 1, w: 2, h: 2, fill: "accent" }] }])).toThrow(/outside/);
		expect(() => parseDeckSlides([{ layout: "free", elements: [{ type: "image", image: "a", x: -1, y: 1, w: 2, h: 2 }] }])).toThrow(/x must be between/);
		// folga de arredondamento é aceita
		expect(() => parseDeckSlides([{ layout: "free", elements: [text({ x: 9.34, w: 4 })] }])).not.toThrow();
	});

	it("limita elementos, texto, cores, ícones e tipos", () => {
		const many = Array.from({ length: DECK_FREE_MAX_ELEMENTS + 1 }, () => text());
		expect(() => parseDeckSlides([{ layout: "free", elements: many }])).toThrow(/too many/i);
		expect(() => parseDeckSlides([{ layout: "free", elements: [] }])).toThrow(/at least 1/);
		expect(() => parseDeckSlides([{ layout: "free", elements: [text({ text: "x".repeat(1_201) })] }])).toThrow(/too long/);
		expect(() => parseDeckSlides([{ layout: "free", elements: [text({ color: "red" })] }])).toThrow(/hex color/);
		expect(() => parseDeckSlides([{ layout: "free", elements: [text({ size: 4 })] }])).toThrow(/size must be between/);
		expect(() => parseDeckSlides([{ layout: "free", elements: [{ type: "icon", name: "unicorn", x: 1, y: 1, w: 1, h: 1 }] }])).toThrow(/not an available icon/);
		expect(() => parseDeckSlides([{ layout: "free", elements: [{ type: "video", x: 1, y: 1, w: 1, h: 1 }] }])).toThrow(/type must be one of/);
		expect(() => parseDeckSlides([{ layout: "free", elements: [{ type: "shape", shape: "line", x: 1, y: 1, w: 2, h: 0 }] }])).toThrow(/stroke/);
	});

	it("imagem de elemento e de fundo nunca é URL", () => {
		expect(() => parseDeckSlides([{ layout: "free", elements: [{ type: "image", image: "https://x.com/a.png", x: 1, y: 1, w: 2, h: 2 }] }])).toThrow(/not a URL/);
		expect(() => parseDeckSlides([{ layout: "title", title: "T", background: { image: "data:image/png;base64,AAAA" } }])).toThrow(/not a URL/);
	});

	it("todos os ícones listados têm desenho (lista única)", () => {
		expect(new Set(DECK_ICON_NAMES).size).toBe(DECK_ICON_NAMES.length);
	});
});

describe("background", () => {
	it("cor, gradiente e imagem com véu em qualquer layout", () => {
		const slides = parseDeckSlides([
			{ layout: "title", title: "Capa", background: "#0f172a" },
			{ layout: "section", title: "Seção", background: { gradient: { from: "#0f172a", to: "accent", angle: 90 } } },
			{ layout: "title", title: "Foto", background: { image: "artifact:bg-1", scrim: { color: "#000", opacity: 0.6 } } },
			{ layout: "closing", title: "Fim", background: { image: "bg-2", scrim: false } },
			{ layout: "bullets", title: "Texto", bullets: ["a"], background: { image: "bg-3" } },
		]);
		expect(slides.map((s) => s.background)).toEqual([
			{ kind: "color", color: "#0f172a" },
			{ kind: "gradient", from: "#0f172a", to: "accent", angle: 90 },
			{ kind: "image", image: "bg-1", scrim: { color: "#000000", opacity: 0.6 } },
			{ kind: "image", image: "bg-2", scrim: false },
			{ kind: "image", image: "bg-3" },
		]);
	});

	it("exige exatamente um tipo e valida o véu", () => {
		expect(() => parseDeckSlides([{ title: "x", background: {} }])).toThrow(/exactly one/);
		expect(() => parseDeckSlides([{ title: "x", background: { color: "#fff", image: "a" } }])).toThrow(/exactly one/);
		expect(() => parseDeckSlides([{ title: "x", background: { image: "a", scrim: { opacity: 2 } } }])).toThrow(/opacity must be between/);
		expect(() => parseDeckSlides([{ title: "x", background: "azul" }])).toThrow(/hex color/);
	});

	it("deckImageIds junta layout image, elementos livres e fundos sem repetir", () => {
		const slides = parseDeckSlides([
			{ layout: "image", title: "I", image: "a", background: { image: "b" } },
			{ layout: "free", elements: [{ type: "image", image: "a", x: 1, y: 1, w: 2, h: 2 }, { type: "image", image: "c", x: 4, y: 1, w: 2, h: 2 }] },
			{ layout: "title", title: "T", background: { image: "b" } },
		]);
		expect(deckImageIds(slides)).toEqual(["a", "b", "c"]);
	});
});

describe("template_file_id", () => {
	it("aceita id e prefixos, recusa URL", () => {
		expect(parseDeckTemplateId(undefined)).toBeUndefined();
		expect(parseDeckTemplateId("attachment:abc-123")).toBe("abc-123");
		expect(() => parseDeckTemplateId("https://x.com/t.pptx")).toThrow(/not a URL/);
		expect(() => parseDeckTemplateId("../../etc/passwd")).toThrow(/not a valid file id/);
	});

	it("create_file passa o template adiante só para pptx", () => {
		const input = parseCreateFileArgs({ filename: "a.pptx", slides: [{ title: "x" }], template_file_id: "tpl-1" });
		expect(input).toMatchObject({ format: "pptx", templateFileId: "tpl-1" });
		expect(parseCreateFileArgs({ filename: "a.pptx", slides: [{ title: "x" }] })).not.toHaveProperty("templateFileId");
	});
});
