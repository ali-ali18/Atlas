import JSZip from "jszip";

/**
 * Validação e leitura de um .pptx/.potx modelo do usuário. Tudo em memória, sem executar nada do arquivo:
 * confere tamanho, estrutura do zip (anti zip-bomb), recusa macros e extrai layouts, placeholders, tema e
 * tamanho de página. Quem preenche o modelo é o python-pptx na sandbox (`fill.ts`); aqui só se decide e valida.
 */
export const TEMPLATE_MAX_BYTES = 15 * 1024 * 1024;
const MAX_ENTRIES = 2_500;
const MAX_ENTRY_BYTES = 60 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const EMU_PER_INCH = 914_400;

export class TemplateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TemplateError";
	}
}

export type TemplatePlaceholder = {
	/** Valor de `type` do OOXML (title, ctrTitle, subTitle, body, pic, chart, tbl, dt, ftr, sldNum) ou "obj" quando ausente. */
	type: string;
	idx: number;
	/** Polegadas, herdadas do mestre quando o layout não traz posição própria. */
	x?: number;
	y?: number;
	w?: number;
	h?: number;
};

export type TemplateLayout = {
	/** Posição do mestre na apresentação e do layout dentro dele: é como a sandbox os encontra. */
	master: number;
	index: number;
	name: string;
	/** Atributo `type` do layout (title, obj, secHead, twoObj, titleOnly, blank...), quando existe. */
	kind?: string;
	placeholders: TemplatePlaceholder[];
};

export type TemplateTheme = {
	name?: string;
	/** Hex em maiúsculas, sem "#": dk1, lt1, dk2, lt2, accent1..accent6, hlink. */
	colors: Record<string, string>;
	majorFont?: string;
	minorFont?: string;
};

export type TemplateInfo = {
	widthIn: number;
	heightIn: number;
	masters: number;
	layouts: TemplateLayout[];
	theme: TemplateTheme;
	/** Slides de exemplo do modelo (são descartados ao preencher). */
	slideCount: number;
};

export type OpenedTemplate = { info: TemplateInfo; zip: JSZip };

const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

function decodeXml(text: string): string {
	return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

async function text(zip: JSZip, path: string): Promise<string> {
	const file = zip.file(path);
	return file ? file.async("string") : "";
}

function resolveTarget(base: string, target: string): string {
	if (target.startsWith("/")) return target.slice(1);
	const parts = base.split("/").slice(0, -1);
	for (const piece of target.split("/")) {
		if (piece === "..") parts.pop();
		else if (piece && piece !== ".") parts.push(piece);
	}
	return parts.join("/");
}

function relsOf(xml: string, from: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const tag of xml.match(/<Relationship\s[^>]*>/g) ?? []) {
		const id = attr(tag, "Id");
		const target = attr(tag, "Target");
		if (id && target && attr(tag, "TargetMode") !== "External") map.set(id, resolveTarget(from, target));
	}
	return map;
}

const relsPath = (part: string) => part.replace(/([^/]+)$/, "_rels/$1.rels");

/** Zip real, sem macros, dentro dos limites. Lança `TemplateError` com o motivo (mensagem para o modelo/usuário). */
export async function openTemplate(bytes: Uint8Array, filename = "template.pptx"): Promise<OpenedTemplate> {
	if (bytes.byteLength === 0) throw new TemplateError("The template file is empty.");
	if (bytes.byteLength > TEMPLATE_MAX_BYTES) throw new TemplateError(`The template is too large (${Math.round(bytes.byteLength / 1024 / 1024)} MB, max ${TEMPLATE_MAX_BYTES / 1024 / 1024} MB).`);
	if (/\.(pptm|potm|ppsm|ppt|pot|pps)$/i.test(filename)) {
		throw new TemplateError(`Templates with macros or in the old .ppt format are not accepted (${filename}). Ask the user to save it as .pptx or .potx.`);
	}
	if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new TemplateError("The template is not a valid .pptx (it is not a zip file). Ask the user to export it as .pptx from PowerPoint.");
	let zip: JSZip;
	try {
		zip = await JSZip.loadAsync(bytes);
	} catch {
		throw new TemplateError("The template could not be opened: the zip is damaged. Ask the user to export it again as .pptx.");
	}
	const names = Object.keys(zip.files);
	if (names.length > MAX_ENTRIES) throw new TemplateError(`The template has too many internal files (${names.length}).`);
	let total = 0;
	for (const name of names) {
		const size = (zip.files[name] as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
		total += size;
		if (size > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) throw new TemplateError("The template expands to an unreasonable size and was refused.");
		if (name.includes("..") || name.startsWith("/")) throw new TemplateError("The template has an invalid internal path and was refused.");
	}
	const contentTypes = await text(zip, "[Content_Types].xml");
	if (!contentTypes || !zip.file("ppt/presentation.xml")) throw new TemplateError("The file is a zip but not a PowerPoint presentation (ppt/presentation.xml is missing).");
	if (names.some((n) => /^ppt\/vbaProject\.bin$/i.test(n) || /^ppt\/activeX\//i.test(n)) || /macroEnabled|vbaProject/i.test(contentTypes)) {
		throw new TemplateError("The template contains macros (VBA) or ActiveX controls, which are not accepted. Ask the user to save a macro-free .pptx.");
	}
	return { info: await readInfo(zip), zip };
}

/** Converte .potx em .pptx trocando o tipo do conteúdo principal (python-pptx só abre `presentation.main`). */
export async function templateAsPptx({ zip }: OpenedTemplate): Promise<Uint8Array> {
	const path = "[Content_Types].xml";
	const xml = await text(zip, path);
	const fixed = xml.replace(/presentationml\.template\.main\+xml/g, "presentationml.presentation.main+xml");
	if (fixed !== xml) zip.file(path, fixed);
	return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function geometry(block: string): Pick<TemplatePlaceholder, "x" | "y" | "w" | "h"> {
	const off = /<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/.exec(block);
	const ext = /<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/.exec(block);
	if (!off || !ext) return {};
	const inch = (n: string) => Math.round((Number(n) / EMU_PER_INCH) * 100) / 100;
	return { x: inch(off[1]!), y: inch(off[2]!), w: inch(ext[1]!), h: inch(ext[2]!) };
}

function placeholdersOf(xml: string): TemplatePlaceholder[] {
	const out: TemplatePlaceholder[] = [];
	for (const block of xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? []) {
		const ph = /<p:ph(\s[^>]*)?\/?>/.exec(block);
		if (!ph) continue;
		const tag = ph[0];
		out.push({ type: attr(tag, "type") ?? "obj", idx: Number(attr(tag, "idx") ?? 0), ...geometry(block) });
	}
	return out;
}

/** Placeholders de um layout, com a posição do mestre quando o layout não define a sua. */
function withInheritedGeometry(layoutPhs: TemplatePlaceholder[], masterPhs: TemplatePlaceholder[]): TemplatePlaceholder[] {
	const family = (type: string) => (type === "ctrTitle" || type === "title" ? "title" : type === "subTitle" || type === "body" || type === "obj" ? "body" : type);
	return layoutPhs.map((ph) => {
		if (ph.w !== undefined) return ph;
		const parent = masterPhs.find((m) => family(m.type) === family(ph.type));
		return parent?.w === undefined ? ph : { ...ph, x: parent.x, y: parent.y, w: parent.w, h: parent.h };
	});
}

async function readTheme(zip: JSZip, masterPath: string, rels: Map<string, string>): Promise<TemplateTheme> {
	const themePath = [...rels.values()].find((p) => p.startsWith("ppt/theme/")) ?? "ppt/theme/theme1.xml";
	const xml = await text(zip, themePath);
	const colors: Record<string, string> = {};
	const scheme = /<a:clrScheme[\s\S]*?<\/a:clrScheme>/.exec(xml)?.[0] ?? "";
	for (const key of ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink"]) {
		const part = new RegExp(`<a:${key}>([\\s\\S]*?)</a:${key}>`).exec(scheme)?.[1] ?? "";
		const hex = /<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/.exec(part)?.[1] ?? /<a:sysClr[^>]*lastClr="([0-9A-Fa-f]{6})"/.exec(part)?.[1];
		if (hex) colors[key] = hex.toUpperCase();
	}
	const font = (kind: "majorFont" | "minorFont") => {
		const typeface = new RegExp(`<a:${kind}>\\s*<a:latin\\s+typeface="([^"]*)"`).exec(xml)?.[1];
		return typeface && !typeface.startsWith("+") ? decodeXml(typeface) : undefined;
	};
	const name = /<a:theme[^>]*\sname="([^"]*)"/.exec(xml)?.[1];
	void masterPath;
	return { ...(name ? { name: decodeXml(name) } : {}), colors, ...(font("majorFont") ? { majorFont: font("majorFont") } : {}), ...(font("minorFont") ? { minorFont: font("minorFont") } : {}) };
}

async function readInfo(zip: JSZip): Promise<TemplateInfo> {
	const presentation = await text(zip, "ppt/presentation.xml");
	const presRels = relsOf(await text(zip, relsPath("ppt/presentation.xml")), "ppt/presentation.xml");
	const size = /<p:sldSz\s[^>]*>/.exec(presentation)?.[0] ?? "";
	const cx = Number(attr(size, "cx") ?? 12_192_000);
	const cy = Number(attr(size, "cy") ?? 6_858_000);
	const masterIds = [...(/<p:sldMasterIdLst>([\s\S]*?)<\/p:sldMasterIdLst>/.exec(presentation)?.[1] ?? "").matchAll(/r:id="([^"]+)"/g)].map((m) => m[1]!);
	const masterPaths = masterIds.map((id) => presRels.get(id)).filter((p): p is string => Boolean(p));
	if (masterPaths.length === 0) throw new TemplateError("The template has no slide master, so it cannot be used.");
	const layouts: TemplateLayout[] = [];
	let theme: TemplateTheme = { colors: {} };
	for (const [masterIndex, masterPath] of masterPaths.entries()) {
		const masterXml = await text(zip, masterPath);
		const masterRels = relsOf(await text(zip, relsPath(masterPath)), masterPath);
		if (masterIndex === 0) theme = await readTheme(zip, masterPath, masterRels);
		const masterPhs = placeholdersOf(masterXml);
		const layoutIds = [...(/<p:sldLayoutIdLst>([\s\S]*?)<\/p:sldLayoutIdLst>/.exec(masterXml)?.[1] ?? "").matchAll(/r:id="([^"]+)"/g)].map((m) => m[1]!);
		for (const [index, id] of layoutIds.entries()) {
			const layoutPath = masterRels.get(id);
			if (!layoutPath) continue;
			const xml = await text(zip, layoutPath);
			if (!xml) continue;
			const root = /<p:sldLayout\s[^>]*>/.exec(xml)?.[0] ?? "";
			const kind = attr(root, "type");
			const name = decodeXml(/<p:cSld\s+(?:[^>]*?\s)?name="([^"]*)"/.exec(xml)?.[1] ?? "") || `Layout ${index + 1}`;
			layouts.push({ master: masterIndex, index, name, ...(kind ? { kind } : {}), placeholders: withInheritedGeometry(placeholdersOf(xml), masterPhs) });
		}
	}
	if (layouts.length === 0) throw new TemplateError("The template has no slide layouts, so it cannot be used.");
	const slideCount = ((/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/.exec(presentation)?.[1] ?? "").match(/<p:sldId\s/g) ?? []).length;
	return { widthIn: Math.round((cx / EMU_PER_INCH) * 1000) / 1000, heightIn: Math.round((cy / EMU_PER_INCH) * 1000) / 1000, masters: masterPaths.length, layouts, theme, slideCount };
}

/** Resumo para o modelo escolher layouts (nome, tipo e placeholders de conteúdo). */
export function describeTemplate(info: TemplateInfo): string {
	const lines = info.layouts.map((l) => {
		const phs = l.placeholders.filter((p) => !["dt", "ftr", "sldNum"].includes(p.type)).map((p) => p.type).join(", ");
		return `- "${l.name}"${l.kind ? ` [${l.kind}]` : ""}${l.master > 0 ? ` (master ${l.master + 1})` : ""}: ${phs || "no placeholders"}`;
	});
	const colors = Object.entries(info.theme.colors).slice(0, 8).map(([k, v]) => `${k}=#${v}`).join(" ");
	return [
		`Template: ${info.widthIn} x ${info.heightIn} in, ${info.layouts.length} layouts, ${info.slideCount} sample slide${info.slideCount === 1 ? "" : "s"} (dropped on fill).`,
		`Fonts: heading ${info.theme.majorFont ?? "theme"}, body ${info.theme.minorFont ?? "theme"}. Colors: ${colors || "theme"}.`,
		"Layouts:",
		...lines,
	].join("\n");
}
