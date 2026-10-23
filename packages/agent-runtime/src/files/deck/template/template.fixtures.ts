import JSZip from "jszip";
import pptxgen from "pptxgenjs";

type Pptx = InstanceType<typeof pptxgen.default>;
const PptxGenJS = pptxgen as unknown as new () => Pptx;

/**
 * Modelo corporativo de teste, gerado na hora: 5 layouts com placeholders (capa, conteúdo, duas colunas,
 * só título, em branco), cor de destaque vermelha e fontes próprias, mais um slide de exemplo.
 * Os `type=` dos layouts são acrescentados no XML, como o PowerPoint faz.
 */
export async function buildFixtureTemplate(options: { macro?: boolean; wide?: boolean; ext?: "pptx" | "potx" } = {}): Promise<Uint8Array> {
	const pptx = new PptxGenJS();
	pptx.layout = options.wide === false ? "LAYOUT_4x3" : "LAYOUT_WIDE";
	pptx.theme = { headFontFace: "Georgia", bodyFontFace: "Verdana" };
	const W = options.wide === false ? 10 : 13.333;
	const title = { name: "Titulo", type: "title" as const, x: 0.6, y: 0.4, w: W - 1.2, h: 1.1, fontSize: 32, color: "7A1F1F", fontFace: "Georgia", bold: true };
	pptx.defineSlideMaster({
		title: "Capa",
		background: { color: "7A1F1F" },
		objects: [
			{ rect: { x: 0, y: 6.9, w: W, h: 0.6, fill: { color: "C0392B" } } },
			{ placeholder: { options: { ...title, color: "FFFFFF", y: 2, h: 1.6 }, text: "" } },
			{ placeholder: { options: { name: "Subtitulo", type: "body", x: 0.6, y: 3.8, w: W - 1.2, h: 1, fontSize: 20, color: "F5D0CC" }, text: "" } },
		],
	});
	pptx.defineSlideMaster({
		title: "Conteudo",
		background: { color: "FFFFFF" },
		objects: [
			{ rect: { x: 0, y: 0, w: W, h: 0.2, fill: { color: "C0392B" } } },
			{ placeholder: { options: title, text: "" } },
			{ placeholder: { options: { name: "Corpo", type: "body", x: 0.6, y: 1.8, w: W - 1.2, h: 4.8, fontSize: 22, color: "222222" }, text: "" } },
		],
		slideNumber: { x: W - 1, y: 7, w: 0.6, h: 0.3, fontSize: 11 },
	});
	pptx.defineSlideMaster({
		title: "Duas colunas",
		background: { color: "FFFFFF" },
		objects: [
			{ placeholder: { options: title, text: "" } },
			{ placeholder: { options: { name: "Esquerda", type: "body", x: 0.6, y: 1.8, w: (W - 1.8) / 2, h: 4.8, fontSize: 20 }, text: "" } },
			{ placeholder: { options: { name: "Direita", type: "body", x: 0.6 + (W - 1.8) / 2 + 0.6, y: 1.8, w: (W - 1.8) / 2, h: 4.8, fontSize: 20 }, text: "" } },
		],
	});
	pptx.defineSlideMaster({
		title: "So titulo",
		background: { color: "FFFFFF" },
		objects: [{ rect: { x: 0, y: 0, w: W, h: 0.2, fill: { color: "C0392B" } } }, { placeholder: { options: title, text: "" } }],
	});
	pptx.defineSlideMaster({ title: "Em branco", background: { color: "FFFFFF" }, objects: [{ rect: { x: 0, y: 7.1, w: W, h: 0.4, fill: { color: "C0392B" } } }] });
	const sample = pptx.addSlide({ masterName: "Conteudo" });
	sample.addText("Slide de exemplo do modelo", { placeholder: "Titulo" });
	sample.addText("Texto antigo que deve sumir", { placeholder: "Corpo" });
	const zip = await JSZip.loadAsync((await pptx.write({ outputType: "uint8array" })) as Uint8Array);
	// type= dos layouts, como o PowerPoint grava
	const kinds: Record<string, string> = { Capa: "title", Conteudo: "obj", "Duas colunas": "twoObj", "So titulo": "titleOnly", "Em branco": "blank" };
	for (const name of Object.keys(zip.files).filter((n) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(n))) {
		let xml = await zip.file(name)!.async("string");
		const layoutName = /<p:cSld name="([^"]*)"/.exec(xml)?.[1] ?? "";
		const kind = kinds[layoutName];
		if (kind && !/<p:sldLayout[^>]*\stype=/.test(xml)) xml = xml.replace("<p:sldLayout ", `<p:sldLayout type="${kind}" `);
		zip.file(name, xml);
	}
	const theme = zip.file("ppt/theme/theme1.xml");
	if (theme) {
		const xml = (await theme.async("string")).replace(/(<a:accent1>)[\s\S]*?(<\/a:accent1>)/, '$1<a:srgbClr val="C0392B"/>$2').replace(/(<a:accent2>)[\s\S]*?(<\/a:accent2>)/, '$1<a:srgbClr val="1F6F8B"/>$2');
		zip.file("ppt/theme/theme1.xml", xml);
	}
	if (options.macro) zip.file("ppt/vbaProject.bin", new Uint8Array([1, 2, 3]));
	if (options.ext === "potx") {
		const ct = await zip.file("[Content_Types].xml")!.async("string");
		zip.file("[Content_Types].xml", ct.replace("presentationml.presentation.main+xml", "presentationml.template.main+xml"));
	}
	return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
