import { createRequire } from "node:module";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { parseCreateFileArgs, parseDeckSlides } from "@workspace/shared";
import { resolveDeckImages } from "./deck/images.js";
import { chartLabels, chartNumberFormat } from "./deck/charts.js";
import { buildPalette, readableOn } from "./deck/themes.js";
import { fitInside } from "./deck/layouts.js";
import { renderFile } from "./render.js";
import { renderPptx } from "./pptx.js";

// O docx empacota o jszip; resolve a partir dele para não depender de uma dependência direta nova.
const require = createRequire(import.meta.url);
type Zip = { files: Record<string, unknown>; file(name: string): { async(type: "string"): Promise<string> } | null };
const JSZip = require(require.resolve("jszip", { paths: [require.resolve("docx")] })) as { loadAsync(data: Uint8Array): Promise<Zip> };

async function open(bytes: Uint8Array) {
	const zip = await JSZip.loadAsync(bytes);
	const names = Object.keys(zip.files);
	const read = async (name: string) => (await zip.file(name)?.async("string")) ?? "";
	const slideNames = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
	return { names, read, slideNames };
}

const BAR = { type: "bar", x: "mes", series: [{ key: "total", label: "Faturamento" }], data: [{ mes: "2026-09-01", total: 148200 }, { mes: "2026-10-01", total: 164750.5 }], unit: "BRL" };

const DECK = [
	{ layout: "title", title: "Vendas Loja Exemplo", subtitle: "Outubro/2026", notes: "Abra falando do mês." },
	{ layout: "agenda", items: ["Resultado", "Canais"] },
	{ layout: "section", title: "Resultado" },
	{ layout: "stats", title: "Em números", stats: [{ value: "R$ 164 mil", label: "Faturamento", detail: "+11% vs. setembro" }, { value: "1.286", label: "Pedidos" }] },
	{ layout: "chart", title: "Faturamento", chart: BAR, notes: "Ponto de atenção: outubro." },
	{ layout: "chart", title: "Canais", chart: { type: "pie", x: "canal", series: [{ key: "v" }], data: [{ canal: "Loja", v: 60 }, { canal: "ML", v: 40 }] } },
	{ layout: "table", title: "Top produtos", columns: ["Produto", "Receita"], rows: [["Adubo", "24.720"], ["Semente", "9.700"]] },
	{ layout: "two_column", title: "Prós e contras", columns: [{ heading: "Pró", bullets: ["a"] }, { heading: "Contra", bullets: ["b"] }] },
	{ layout: "quote", quote: "Cliente quer aprender", author: "Equipe" },
	{ layout: "timeline", title: "Plano", steps: [{ label: "03/11", title: "Estoque" }, { label: "17/11", title: "Campanha", text: "Kits" }] },
	{ layout: "bullets", title: "Decisões", bullets: [{ text: "Comprar substrato", sub: ["6 dias de estoque"] }, "Definir meta"] },
	{ layout: "closing", title: "Obrigado", bullets: ["Meta: R$ 180 mil"] },
];

describe("renderPptx", () => {
	it("gera um slide por item, com nativo para gráfico e tabela e notas do apresentador", async () => {
		const bytes = await renderPptx(parseDeckSlides(DECK), { title: "Vendas Loja Exemplo", theme: "clean" });
		expect(Buffer.from(bytes).subarray(0, 2).toString()).toBe("PK");
		const { names, read, slideNames } = await open(bytes);
		expect(slideNames).toHaveLength(DECK.length);

		const slideXml = await Promise.all(slideNames.map(read));
		// tabela nativa no slide 7 e gráficos nativos (partes de chart) nos slides 5 e 6
		expect(slideXml[6]).toContain("<a:tbl>");
		expect(slideXml[6]).toContain("Adubo");
		expect(names.filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))).toHaveLength(2);
		const chartXml = await Promise.all(names.filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n)).map(read));
		expect(chartXml.some((x) => x.includes("<c:barChart>") && x.includes("Faturamento"))).toBe(true);
		expect(chartXml.some((x) => x.includes("<c:pieChart>"))).toBe(true);
		// notas do apresentador
		const notes = await Promise.all(names.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).map(read));
		expect(notes.join(" ")).toContain("Abra falando do mês.");
		expect(notes.join(" ")).toContain("Ponto de atenção: outubro.");
		// KPI e sub-bullet viram texto do slide; título do deck aparece no rodapé dos slides de conteúdo
		expect(slideXml[3]).toContain("R$ 164 mil");
		expect(slideXml[3]).toContain("+11% vs. setembro");
		expect(slideXml[10]).toContain("6 dias de estoque");
		expect(slideXml[1]).toBeDefined();
		const layouts = await Promise.all(names.filter((n) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(n)).map(read));
		expect(layouts.join(" ")).toContain("Vendas Loja Exemplo");
		expect(layouts.join(" ")).toContain("slidenum");
	});

	it("o formato antigo {title, bullets} continua gerando um deck", async () => {
		const out = await renderFile(parseCreateFileArgs({ filename: "velho.pptx", slides: [{ title: "Oi", bullets: ["a", "b"] }, { title: "Tchau", bullets: [] }] }));
		const { slideNames, read } = await open(out.bytes);
		expect(slideNames).toHaveLength(2);
		expect(await read(slideNames[0]!)).toContain("Oi");
	});

	it("tema e cor da marca mudam as cores do arquivo", async () => {
		const slides = parseDeckSlides([{ layout: "bullets", title: "Cor", bullets: ["x"] }]);
		const clean = await open(await renderPptx(slides, { theme: "clean" }));
		const brand = await open(await renderPptx(slides, { theme: "clean", brandColor: "#16a34a" }));
		const dark = await open(await renderPptx(slides, { theme: "dark" }));
		const cleanXml = (await Promise.all(clean.names.filter((n) => n.includes("slideLayout") && n.endsWith(".xml")).map(clean.read))).join("");
		const brandXml = (await Promise.all(brand.names.filter((n) => n.includes("slideLayout") && n.endsWith(".xml")).map(brand.read))).join("");
		const darkXml = (await Promise.all(dark.names.filter((n) => n.includes("slideLayout") && n.endsWith(".xml")).map(dark.read))).join("");
		expect(cleanXml).toContain("2563EB");
		expect(brandXml).toContain("16A34A");
		expect(brandXml).not.toContain("2563EB");
		expect(darkXml).toContain("0F172A");
	});

	it("slide de imagem embute a mídia e recusa imagem não resolvida", async () => {
		const png = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#16a34a" } }).png().toBuffer();
		const slides = parseDeckSlides([{ layout: "image", title: "Foto", image: "img-1", caption: "Legenda" }]);
		const images = new Map([["img-1", { data: `image/png;base64,${png.toString("base64")}`, width: 40, height: 20 }]]);
		const { names } = await open(await renderPptx(slides, { images }));
		expect(names.some((n) => n.startsWith("ppt/media/"))).toBe(true);
		await expect(renderPptx(slides, {})).rejects.toThrow(/not resolved/);
	});
});

describe("resolveDeckImages", () => {
	it("usa só imagens do dono na conversa; nada de URL nem de outro usuário", async () => {
		const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).png().toBuffer();
		const slides = parseDeckSlides([{ layout: "image", title: "A", image: "mine" }]);
		const loadArtifact = vi.fn(async (id: string, userId: string) =>
			id === "mine" && userId === "user-a" ? ({ id, kind: "image", bytes: png, conversationId: "conv-1", meta: { mime: "image/png" } } as never) : null,
		);
		const ok = await resolveDeckImages(slides, { userId: "user-a", conversationId: "conv-1", loadArtifact });
		expect(ok.get("mine")).toMatchObject({ width: 8, height: 8 });
		expect(loadArtifact).toHaveBeenCalledWith("mine", "user-a");
		// outro usuário: o artefato "não existe"
		await expect(resolveDeckImages(slides, { userId: "user-b", conversationId: "conv-1", loadArtifact })).rejects.toThrow(/not found/);
		// artefato de outra conversa
		await expect(resolveDeckImages(slides, { userId: "user-a", conversationId: "conv-2", loadArtifact })).rejects.toThrow(/not found/);
		// artefato que não é imagem
		const file = vi.fn(async () => ({ id: "mine", kind: "file", bytes: png, conversationId: "conv-1", meta: {} }) as never);
		await expect(resolveDeckImages(slides, { userId: "user-a", loadArtifact: file })).rejects.toThrow(/not found/);
	});

	it("anexos da conversa valem e imagem ilegível dá erro acionável", async () => {
		const png = await sharp({ create: { width: 10, height: 5, channels: 3, background: "#fff" } }).png().toBuffer();
		const slides = parseDeckSlides([{ layout: "image", title: "A", image: "att-1" }]);
		const attachments = { list: async () => [{ id: "att-1", filename: "foto.png" }], bytes: async () => new Uint8Array(png) };
		const loadArtifact = vi.fn(async () => null);
		const out = await resolveDeckImages(slides, { userId: "u", attachments, loadArtifact });
		expect(out.get("att-1")).toMatchObject({ width: 10, height: 5 });
		expect(loadArtifact).not.toHaveBeenCalled();
		const bad = { list: attachments.list, bytes: async () => new TextEncoder().encode("não é imagem") };
		await expect(resolveDeckImages(slides, { userId: "u", attachments: bad })).rejects.toThrow(/could not be used/);
	});
});

describe("helpers do deck", () => {
	it("rótulos de datas ISO e formato numérico por unidade", () => {
		const spec = parseDeckSlides([{ layout: "chart", title: "t", chart: BAR }])[0] as { chart: Parameters<typeof chartLabels>[0] };
		expect(chartLabels(spec.chart)).toEqual(["09/2026", "10/2026"]);
		expect(chartNumberFormat(spec.chart)).toBe('"R$" #,##0.00');
		expect(chartNumberFormat({ ...spec.chart, unit: "%", data: [{ mes: "a", total: 5 }] })).toBe('0"%"');
	});
	it("paleta: contraste e cor da marca", () => {
		expect(readableOn("FFFFFF")).toBe("111827");
		expect(readableOn("0F172A")).toBe("FFFFFF");
		const p = buildPalette("corporate", "#16a34a");
		expect(p.accent).toBe("16A34A");
		expect(p.coverBg).not.toBe(buildPalette("corporate").coverBg);
	});
	it("fitInside mantém a proporção e centraliza", () => {
		expect(fitInside({ x: 0, y: 0, w: 10, h: 10 }, { width: 200, height: 100 })).toEqual({ x: 0, y: 2.5, w: 10, h: 5 });
	});
});
