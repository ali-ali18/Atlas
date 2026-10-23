import JSZip from "jszip";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { parseDeckSlides } from "@workspace/shared";
import { openPptx } from "../pptx-zip.fixtures.js";
import { fillTemplate } from "./fill.js";
import { describeTemplate, openTemplate, TEMPLATE_MAX_BYTES, TemplateError, templateAsPptx } from "./inspect.js";
import { HAS_PYTHON_PPTX, HAS_SOFFICE, runPythonLocally } from "./local-runner.fixtures.js";
import { chooseLayout, planTemplateDeck } from "./plan.js";
import { buildFixtureTemplate } from "./template.fixtures.js";

describe("openTemplate: validação do arquivo do usuário", () => {
	it("lê layouts, placeholders, tema e tamanho do modelo", async () => {
		const { info } = await openTemplate(await buildFixtureTemplate(), "modelo.pptx");
		expect(info).toMatchObject({ widthIn: 13.333, heightIn: 7.5, masters: 1, slideCount: 1 });
		expect(info.layouts.map((l) => l.name)).toEqual(expect.arrayContaining(["Capa", "Conteudo", "Duas colunas", "So titulo", "Em branco"]));
		const two = info.layouts.find((l) => l.name === "Duas colunas")!;
		expect(two.kind).toBe("twoObj");
		expect(two.placeholders.filter((p) => p.type === "body")).toHaveLength(2);
		expect(two.placeholders[0]).toMatchObject({ type: "title", x: 0.6, w: 12.13 });
		expect(info.theme).toMatchObject({ majorFont: "Georgia", minorFont: "Verdana" });
		expect(info.theme.colors).toMatchObject({ accent1: "C0392B", accent2: "1F6F8B", dk1: "000000", lt1: "FFFFFF" });
		const text = describeTemplate(info);
		expect(text).toContain('"Capa" [title]');
		expect(text).toContain("accent1=#C0392B");
	});

	it("recusa arquivo vazio, grande, não-zip, zip sem pptx, macros e extensões .pptm/.ppt", async () => {
		await expect(openTemplate(new Uint8Array())).rejects.toThrow(/empty/);
		await expect(openTemplate(new Uint8Array(TEMPLATE_MAX_BYTES + 1))).rejects.toThrow(/too large/);
		await expect(openTemplate(new TextEncoder().encode("isto não é um zip"))).rejects.toThrow(/not a valid \.pptx/);
		const notPptx = await new JSZip().file("a.txt", "x").generateAsync({ type: "uint8array" });
		await expect(openTemplate(notPptx)).rejects.toThrow(/not a PowerPoint presentation/);
		await expect(openTemplate(await buildFixtureTemplate({ macro: true }), "m.pptx")).rejects.toThrow(/macros/);
		await expect(openTemplate(await buildFixtureTemplate(), "m.pptm")).rejects.toThrow(/macros or in the old \.ppt/);
		await expect(openTemplate(await buildFixtureTemplate(), "velho.ppt")).rejects.toThrow(TemplateError);
		const damaged = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4, 5]);
		await expect(openTemplate(damaged)).rejects.toThrow(/damaged/);
	});

	it(".potx é normalizado para .pptx (o python-pptx só abre presentation.main)", async () => {
		const opened = await openTemplate(await buildFixtureTemplate({ ext: "potx" }), "modelo.potx");
		const fixed = await JSZip.loadAsync(await templateAsPptx(opened));
		const types = await fixed.file("[Content_Types].xml")!.async("string");
		expect(types).toContain("presentationml.presentation.main+xml");
		expect(types).not.toContain("template.main+xml");
	});
});

describe("planTemplateDeck: escolha de layout e conteúdo", () => {
	const slides = () =>
		parseDeckSlides([
			{ layout: "title", title: "Plano 2027", subtitle: "Diretoria" },
			{ layout: "bullets", title: "Metas", bullets: ["Crescer", { text: "Margem", sub: ["+2 p.p."] }], notes: "Falar devagar" },
			{ layout: "two_column", title: "Antes e depois", columns: [{ heading: "Antes", bullets: ["a"] }, { heading: "Depois", bullets: ["b"] }] },
			{ layout: "stats", title: "Resultado", stats: [{ value: "R$ 1 mi", label: "Receita" }, { value: "12%", label: "Margem" }] },
			{ layout: "chart", title: "Vendas", chart: { type: "bar", x: "m", series: [{ key: "v", label: "V" }], data: [{ m: "Jan", v: 1 }, { m: "Fev", v: 2 }] } },
			{ layout: "free", elements: [{ type: "text", x: 6.6665, y: 3.75, w: 4, h: 1, text: "Centro", size: 40 }] },
			{ layout: "closing", title: "Obrigado", bullets: ["contato@x.com"] },
		]);

	it("usa os layouts do modelo: capa, conteúdo, duas colunas, só título e em branco", async () => {
		const { info } = await openTemplate(await buildFixtureTemplate());
		const plan = planTemplateDeck(slides(), info);
		expect(plan.slides.map((s) => s.layoutName)).toEqual(["Capa", "Conteudo", "Duas colunas", "So titulo", "So titulo", "Em branco", "Capa"]);
		// título e corpo vão para os placeholders do usuário (herdam fonte e cor do modelo)
		const bullets = plan.slides[1]!;
		expect(bullets.fills).toHaveLength(2);
		expect(bullets.fills[1]!.lines).toEqual([{ text: "Crescer", level: 0 }, { text: "Margem", level: 0 }, { text: "+2 p.p.", level: 1 }]);
		expect(bullets.notes).toBe("Falar devagar");
		// duas colunas: cabeçalho em negrito + itens, um corpo para cada coluna
		expect(plan.slides[2]!.fills.slice(1).map((f) => f.lines[0])).toEqual([{ text: "Antes", level: 0, bold: true }, { text: "Depois", level: 0, bold: true }]);
		// KPIs, gráfico viram elementos nativos abaixo do título (área vem do placeholder de título)
		const stats = plan.slides[3]!;
		expect(stats.elements.length).toBeGreaterThan(5);
		for (const el of stats.elements) expect(el.y).toBeGreaterThanOrEqual(1.6);
		expect(plan.slides[4]!.elements[0]).toMatchObject({ type: "chart", kind: "bar", labels: ["Jan", "Fev"], series: [{ name: "V", values: [1, 2] }] });
		// closing: itens vão para o subtítulo da capa
		expect(plan.slides[6]!.fills.some((f) => f.lines.some((l) => l.text === "contato@x.com"))).toBe(true);
	});

	it("template_layout escolhe o layout pelo nome; nome desconhecido cai na escolha automática", async () => {
		const { info } = await openTemplate(await buildFixtureTemplate());
		const [bullets] = parseDeckSlides([{ layout: "bullets", title: "T", bullets: ["a"] }]);
		expect(chooseLayout(info, bullets!, "so titulo").layout.name).toBe("So titulo");
		expect(chooseLayout(info, bullets!, "nao existe").layout.name).toBe("Conteudo");
	});

	it("layout livre é escalado para o tamanho do modelo (4:3 = 10 x 7.5 pol.)", async () => {
		const { info } = await openTemplate(await buildFixtureTemplate({ wide: false }));
		expect(info.widthIn).toBe(10);
		const plan = planTemplateDeck(slides().slice(5, 6), info);
		const text = plan.slides[0]!.elements[0]!;
		expect(text).toMatchObject({ type: "text", size: 30 });
		expect((text as { x: number }).x).toBeCloseTo(5, 2);
	});

	it("fundo escolhido troca os tokens por cores legíveis e força a cor do texto", async () => {
		const { info } = await openTemplate(await buildFixtureTemplate());
		const [dark] = parseDeckSlides([
			{ layout: "stats", title: "KPIs", stats: [{ value: "1", label: "x" }], background: "#0b132b" },
		]);
		const plan = planTemplateDeck([dark!], info);
		expect(plan.slides[0]!.background).toEqual({ kind: "color", color: "0B132B" });
		expect(plan.slides[0]!.ink).toBe("F8FAFC");
		const texts = plan.slides[0]!.elements.filter((e) => e.type === "text");
		expect(texts.every((e) => e.type === "text" && /^[0-9A-F]{6}$/.test(e.color ?? ""))).toBe(true);
	});
});

describe.skipIf(!HAS_PYTHON_PPTX)("fillTemplate: preenche o modelo com python-pptx", () => {
	async function fill(rawSlides: unknown[], images = new Map<string, { data: string; width: number; height: number }>()) {
		const template = await openTemplate(await buildFixtureTemplate(), "modelo.pptx");
		return fillTemplate({ template, slides: parseDeckSlides(rawSlides), images, run: runPythonLocally, preview: false });
	}

	it("descarta o slide de exemplo, usa os layouts do usuário e mantém texto editável nos placeholders", async () => {
		const out = await fill([
			{ layout: "title", title: "Plano 2027", subtitle: "Diretoria" },
			{ layout: "bullets", title: "Metas", bullets: ["Crescer 20%", { text: "Margem", sub: ["+2 p.p."] }], notes: "Falar devagar" },
			{ layout: "two_column", title: "Antes e depois", columns: [{ heading: "Antes", bullets: ["a"] }, { heading: "Depois", bullets: ["b"] }] },
			{ layout: "stats", title: "Resultado", stats: [{ value: "R$ 1 mi", label: "Receita", detail: "+11%" }, { value: "12%", label: "Margem" }] },
			{ layout: "chart", title: "Vendas", chart: { type: "bar", x: "m", series: [{ key: "v", label: "Vendas" }], data: [{ m: "Jan", v: 1 }, { m: "Fev", v: 2 }] }, caption: "Fonte: ERP" },
			{ layout: "table", title: "Top", columns: ["Produto", "Receita"], rows: [["Adubo", "24.720"], ["Semente", "9.700"]] },
			{ layout: "free", elements: [{ type: "shape", shape: "rounded_rect", x: 1, y: 1, w: 4, h: 2, fill: "accent", text: "Destaque" }, { type: "icon", name: "rocket", x: 6, y: 1, w: 1, h: 1 }] },
		]);
		const { slideNames, read, names } = await openPptx(out.bytes);
		// 7 slides novos; o de exemplo não sobrou
		expect(slideNames).toHaveLength(7);
		const xml = await Promise.all(slideNames.map(read));
		expect(xml.join("")).not.toContain("Texto antigo que deve sumir");
		// cada slide aponta para o layout correto do modelo do usuário
		const layoutOf = async (i: number) => {
			const rels = await read(`ppt/slides/_rels/slide${i + 1}.xml.rels`);
			const target = /Target="\.\.\/slideLayouts\/(slideLayout\d+\.xml)"/.exec(rels)![1]!;
			return /<p:cSld name="([^"]*)"/.exec(await read(`ppt/slideLayouts/${target}`))![1];
		};
		expect(await Promise.all(xml.map((_, i) => layoutOf(i)))).toEqual(["Capa", "Conteudo", "Duas colunas", "So titulo", "So titulo", "So titulo", "Em branco"]);
		// texto em placeholders (<p:ph>), herdando a formatação do modelo (sem tamanho/fonte fixados)
		expect(xml[0]).toContain("Plano 2027");
		expect(xml[0]).toMatch(/<p:ph[^>]*type="title"/);
		expect(xml[1]).toContain("Crescer 20%");
		expect(xml[1]).toContain('lvl="1"');
		expect(xml[1]).not.toMatch(/<a:rPr[^>]*sz=/);
		// KPI e formas usam a cor de TEMA (accent1 do modelo), não o azul do deck embutido
		expect(xml[3]).toContain("R$ 1 mi");
		expect(xml[3]).toContain('<a:schemeClr val="accent1"/>');
		expect(xml[3]).not.toContain("2563EB");
		// gráfico e tabela nativos
		expect(names.some((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))).toBe(true);
		expect(xml[5]).toContain("<a:tbl>");
		expect(xml[5]).toContain("Adubo");
		// forma com texto e ícone (PNG) no layout livre
		expect(xml[6]).toContain("Destaque");
		expect(xml[6]).toContain("<p:pic>");
		// notas do apresentador
		const notes = await Promise.all(names.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).map(read));
		expect(notes.join(" ")).toContain("Falar devagar");
		// o mestre e o tema do usuário seguem no arquivo
		expect(await read("ppt/theme/theme1.xml")).toContain("C0392B");
		expect(out.plan.slides).toHaveLength(7);
	});

	it("placeholders sem conteúdo somem (nada de 'Clique para adicionar texto')", async () => {
		const out = await fill([{ layout: "bullets", title: "Só título", bullets: [] }]);
		const { slide } = await openPptx(out.bytes);
		const xml = await slide(0);
		expect(xml.match(/<p:ph /g)?.length ?? 0).toBeLessThanOrEqual(2);
		expect(xml).not.toContain("Texto antigo");
	});

	it("foto de fundo + véu e imagem em placeholder livre; id da imagem não vira URL", async () => {
		const png = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#2d6a4f" } }).png().toBuffer();
		const images = new Map([["bg", { data: `image/png;base64,${png.toString("base64")}`, width: 800, height: 800 }]]);
		const out = await fill([{ layout: "title", title: "Agro", background: { image: "bg" } }], images);
		const { slide, mediaNames } = await openPptx(out.bytes);
		const xml = await slide(0);
		expect(mediaNames.length).toBeGreaterThanOrEqual(1);
		// foto (pic) vem antes do véu e do título na ordem de desenho
		expect(xml.indexOf("<p:pic>")).toBeLessThan(xml.indexOf("Agro"));
		expect(xml).toContain('<a:alpha val="45000"/>');
	});

	it("falha do script volta como erro acionável, sem caminhos internos", async () => {
		const template = await openTemplate(await buildFixtureTemplate(), "modelo.pptx");
		const broken = async () => ({ exitCode: 1, timedOut: false, stdout: "", stderr: "Traceback...\nKeyError: '/work/in/job.zip'", truncated: false, durationMs: 1, outputs: [], omitted: [], inputNames: [], crashed: false });
		await expect(fillTemplate({ template, slides: parseDeckSlides([{ title: "x" }]), images: new Map(), run: broken })).rejects.toThrow(/Filling the template failed .*<file>/);
		const slow = async () => ({ ...(await broken()), timedOut: true });
		await expect(fillTemplate({ template, slides: parseDeckSlides([{ title: "x" }]), images: new Map(), run: slow })).rejects.toThrow(/timed out/);
	});
});

describe.skipIf(!HAS_PYTHON_PPTX || !HAS_SOFFICE)("fillTemplate com LibreOffice local", () => {
	it("a mesma execução devolve as páginas renderizadas", async () => {
		const template = await openTemplate(await buildFixtureTemplate(), "modelo.pptx");
		const out = await fillTemplate({ template, slides: parseDeckSlides([{ layout: "title", title: "Capa" }, { layout: "bullets", title: "Itens", bullets: ["a", "b"] }]), images: new Map(), run: runPythonLocally });
		expect(out.previews.length).toBe(2);
		expect(out.previews[0]!.name).toMatch(/\.png$/);
	}, 120_000);
});
