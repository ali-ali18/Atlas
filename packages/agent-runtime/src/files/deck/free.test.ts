import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { DECK_ICON_NAMES, parseDeckSlides } from "@workspace/shared";
import { renderPptx } from "../pptx.js";
import { gradientVector, iconSvg } from "./assets.js";
import { adaptPalette, resolveBackdrop } from "./backdrop.js";
import { ICON_NODES } from "./icon-data.js";
import { buildPalette } from "./themes.js";
import { emu, openPptx } from "./pptx-zip.fixtures.js";

async function photo(width: number, height: number, background = "#2d6a4f") {
	const png = await sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
	return { data: `image/png;base64,${png.toString("base64")}`, width, height };
}

describe("layout free", () => {
	it("coloca texto, formas, seta e ícone nas posições pedidas (objetos editáveis)", async () => {
		const slides = parseDeckSlides([
			{
				layout: "free",
				elements: [
					{ type: "text", x: 1, y: 2, w: 5, h: 1.2, text: "O problema", size: 40, bold: true, color: "#112233", align: "center", valign: "middle" },
					{ type: "shape", shape: "rounded_rect", x: 7, y: 2, w: 3, h: 2, fill: "accent", opacity: 0.5, text: "R$ 2 mi", text_size: 28 },
					{ type: "shape", shape: "circle", x: 11, y: 5, w: 1, h: 1, fill: "#ff0000" },
					{ type: "shape", shape: "arrow", x: 5, y: 6, w: 2, h: 0, stroke: "#00aa00", stroke_width: 3 },
					{ type: "shape", shape: "line", x: 8, y: 6, w: -1, h: 1, stroke: "text" },
					{ type: "icon", name: "rocket", x: 1, y: 4, w: 1.5, h: 1.5, color: "#0000ff" },
				],
			},
		]);
		const { slide, names } = await openPptx(await renderPptx(slides, { theme: "clean" }));
		const xml = await slide(0);
		// caixa de texto na posição exata, com a fonte pedida
		expect(xml).toContain(`<a:off x="${emu(1)}" y="${emu(2)}"/><a:ext cx="${emu(5)}" cy="${emu(1.2)}"/>`);
		expect(xml).toContain('sz="4000"');
		expect(xml).toContain("112233");
		expect(xml).toContain("O problema");
		// formas nativas
		expect(xml).toContain('prst="roundRect"');
		expect(xml).toContain('prst="ellipse"');
		expect(xml).toContain("FF0000");
		expect(xml).toContain('<a:alpha val="50000"/>');
		expect(xml).toContain("R$ 2 mi");
		// seta: linha com ponta; linha com vetor negativo espelha
		expect(xml).toContain('prst="line"');
		expect(xml).toContain('<a:tailEnd type="triangle"');
		expect(xml).toMatch(/flipH="1"/);
		// ícone vira uma figura PNG
		expect(names.some((n) => /^ppt\/media\/.*\.png$/.test(n))).toBe(true);
		expect(xml).toContain('descr="rocket"');
	});

	it("tokens de cor seguem o tema e a cor da marca", async () => {
		const slides = parseDeckSlides([{ layout: "free", elements: [{ type: "shape", shape: "rect", x: 1, y: 1, w: 2, h: 2, fill: "accent" }, { type: "text", x: 4, y: 1, w: 3, h: 1, text: "Oi" }] }]);
		const base = await openPptx(await renderPptx(slides, { theme: "clean" }));
		const brand = await openPptx(await renderPptx(slides, { theme: "clean", brandColor: "#16a34a" }));
		expect(await base.slide(0)).toContain("2563EB");
		expect(await brand.slide(0)).toContain("16A34A");
		expect(await brand.slide(0)).not.toContain("2563EB");
	});

	it("imagem contain mantém a proporção e cover recorta à caixa; sem resolver, erro", async () => {
		const slides = parseDeckSlides([
			{
				layout: "free",
				elements: [
					{ type: "image", image: "wide", x: 1, y: 1, w: 4, h: 4, fit: "contain" },
					{ type: "image", image: "wide", x: 6, y: 1, w: 3, h: 3, fit: "cover" },
				],
			},
		]);
		const images = new Map([["wide", await photo(400, 200)]]);
		const { slide, names } = await openPptx(await renderPptx(slides, { images }));
		const xml = await slide(0);
		// contain: 4 x 2 centralizado na caixa 4 x 4
		expect(xml).toContain(`<a:off x="${emu(1)}" y="${emu(2)}"/><a:ext cx="${emu(4)}" cy="${emu(2)}"/>`);
		// cover: caixa 3 x 3 com imagem quadrada recortada
		expect(xml).toContain(`<a:off x="${emu(6)}" y="${emu(1)}"/><a:ext cx="${emu(3)}" cy="${emu(3)}"/>`);
		expect(names.filter((n) => n.startsWith("ppt/media/")).length).toBeGreaterThanOrEqual(2);
		await expect(renderPptx(slides, {})).rejects.toThrow(/not resolved/);
	});

	it("gráfico e tabela nativos dentro de caixas livres", async () => {
		const slides = parseDeckSlides([
			{
				layout: "free",
				elements: [
					{ type: "chart", x: 0.5, y: 1, w: 6, h: 4, chart: { type: "line", x: "m", series: [{ key: "v", label: "Vendas" }], data: [{ m: "a", v: 1 }, { m: "b", v: 3 }] } },
					{ type: "table", x: 7, y: 1, w: 5.5, h: 2, columns: ["Plano", "Preço"], rows: [["Pro", "99"], ["Max", "199"]] },
				],
			},
		]);
		const { slide, names, read } = await openPptx(await renderPptx(slides));
		expect(await slide(0)).toContain("<a:tbl>");
		const chartName = names.find((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))!;
		expect(await read(chartName)).toContain("<c:lineChart>");
		expect(await slide(0)).toContain(`<a:off x="${emu(0.5)}" y="${emu(1)}"/>`);
	});

	it("ícones: toda a lista pública tem desenho e o SVG usa a cor pedida", () => {
		for (const name of DECK_ICON_NAMES) expect(ICON_NODES[name], name).toBeDefined();
		expect(Object.keys(ICON_NODES).sort()).toEqual([...DECK_ICON_NAMES].sort());
		expect(iconSvg("target", "FF0000")).toContain('stroke="#FF0000"');
		expect(iconSvg("nao-existe", "FF0000")).toBeUndefined();
	});
});

describe("fundos", () => {
	it("foto de fundo vira o fundo do slide, recortada em 16:9, com véu translúcido por cima", async () => {
		const slides = parseDeckSlides([
			{ layout: "title", title: "Capa", subtitle: "Tema agro", background: { image: "bg" } },
		]);
		const images = new Map([["bg", await photo(1000, 1000)]]);
		const { slide, mediaNames, readBytes } = await openPptx(await renderPptx(slides, { images }));
		const xml = await slide(0);
		expect(xml).toContain("<p:bg>");
		expect(xml).toContain("<a:blip");
		// véu escuro padrão das capas: 45% de opacidade
		expect(xml).toContain('<a:alpha val="45000"/>');
		expect(xml.indexOf("<p:bg>")).toBeLessThan(xml.indexOf("Capa"));
		// a foto quadrada foi recortada para 1920x1080
		const sizes = await Promise.all(mediaNames.map(async (n) => sharp(Buffer.from(await readBytes(n))).metadata().then((m) => `${m.width}x${m.height}`).catch(() => "?")));
		expect(sizes).toContain("1920x1080");
	});

	it("véu pode ser personalizado ou desligado; em slide de conteúdo o padrão é claro", async () => {
		const images = new Map([["bg", await photo(800, 450)]]);
		const custom = await openPptx(await renderPptx(parseDeckSlides([{ layout: "title", title: "X", background: { image: "bg", scrim: { color: "#1b4332", opacity: 0.7 } } }]), { images }));
		expect(await custom.slide(0)).toContain('<a:alpha val="70000"/>');
		expect(await custom.slide(0)).toContain("1B4332");
		const none = await openPptx(await renderPptx(parseDeckSlides([{ layout: "title", title: "X", background: { image: "bg", scrim: false } }]), { images }));
		expect(await none.slide(0)).not.toContain('<a:alpha val="45000"/>');
		expect(await none.slide(0)).not.toContain('alpha val="82000"');
		const content = await openPptx(await renderPptx(parseDeckSlides([{ layout: "bullets", title: "Texto", bullets: ["a"], background: { image: "bg" } }]), { images }));
		expect(await content.slide(0)).toContain('<a:alpha val="82000"/>');
	});

	it("gradiente e cor sólida; texto claro sobre fundo escuro mesmo no tema claro", async () => {
		const slides = parseDeckSlides([
			{ layout: "bullets", title: "Escuro", bullets: ["item um"], background: { gradient: { from: "#0f172a", to: "#1e3a8a", angle: 90 } } },
			{ layout: "bullets", title: "Cor", bullets: ["item dois"], background: "#102a43" },
			{ layout: "title", title: "Capa clara", background: "#ffffff" },
		]);
		const { slide, mediaNames } = await openPptx(await renderPptx(slides, { theme: "clean" }));
		expect(mediaNames).toHaveLength(1);
		const dark = await slide(0);
		expect(dark).toContain("<p:bg>");
		expect(dark).toContain("F8FAFC");
		const solid = await slide(1);
		expect(solid).toContain('<a:srgbClr val="102A43"/>');
		expect(solid).toContain("F8FAFC");
		// capa sobre fundo branco: texto escuro, nunca branco sobre branco
		const light = await slide(2);
		expect(light).toContain("111827");
	});

	it("adaptPalette e resolveBackdrop (puras)", () => {
		const p = buildPalette("clean");
		const dark = resolveBackdrop({ kind: "color", color: "#0b132b" }, false, p)!;
		expect(dark.dark).toBe(true);
		expect(adaptPalette(p, false, dark).text).toBe("F8FAFC");
		expect(adaptPalette(p, false, undefined)).toBe(p);
		const photoBackdrop = resolveBackdrop({ kind: "image", image: "x" }, true, p)!;
		expect(photoBackdrop).toMatchObject({ dark: true, scrim: { color: "000000", opacity: 0.45 } });
		expect(adaptPalette(p, true, photoBackdrop)).toBe(p);
		const vector = gradientVector(90);
		expect(vector.x1).toBeCloseTo(0);
		expect(vector.x2).toBeCloseTo(1);
	});
});
