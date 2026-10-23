import type { DeckBullet, FreeElement, SlideInput } from "@workspace/shared";
import { iconKey } from "../assets.js";
import { chartNumberFormat, chartSeriesData } from "../charts.js";
import { adaptPalette, resolveBackdrop, resolveDeckColor } from "../backdrop.js";
import { buildPalette, mixColors, readableOn, type DeckPalette } from "../themes.js";
import { semanticElements, scaleFreeElement, type Area } from "./content.js";
import type { TemplateInfo, TemplateLayout, TemplatePlaceholder } from "./inspect.js";

/**
 * Decisão pura de como cada slide ocupa o modelo: qual layout do usuário usar, o que vai em cada
 * placeholder e quais elementos livres completam o slide. A sandbox só executa este plano.
 * Os textos ficam nos placeholders do modelo para herdar fonte, cor e tamanho do usuário.
 */
export type FillLine = { text: string; level: number; bold?: boolean };
export type PlannedFill = { idx: number; lines: FillLine[] };

/** Imagem de um elemento: `asset` é a chave de `prepareDeckAssets`/`image:<id>`; a sandbox recebe o arquivo. */
export type PlannedPicture = { type: "picture"; asset: string; x: number; y: number; w: number; h: number; fit: "contain" | "cover"; alt?: string };
export type PlannedChart = { type: "chart"; x: number; y: number; w: number; h: number; kind: "bar" | "line" | "area" | "pie"; horizontal: boolean; stacked: boolean; labels: string[]; series: Array<{ name: string; values: number[] }>; numberFormat: string };
export type PlannedTable = { type: "table"; x: number; y: number; w: number; h: number; columns: string[]; rows: string[][]; align: Array<"left" | "right">; size: number };
export type PlannedElement = Exclude<FreeElement, { type: "image" | "icon" | "chart" | "table" }> | PlannedPicture | PlannedChart | PlannedTable;

const NUMBER_LIKE = /^[-+−–R$US€\s\d.,%()]+$/;

export type PlannedBackground = { kind: "color"; color: string } | { kind: "picture"; asset: string; scrim?: { color: string; opacity: number } };

export type TemplateSlidePlan = {
	master: number;
	layout: number;
	layoutName: string;
	fills: PlannedFill[];
	elements: PlannedElement[];
	background?: PlannedBackground;
	/** Cor de texto forçada nos placeholders (só quando o fundo escolhido contraria o do modelo). */
	ink?: string;
	notes?: string;
};

export type TemplatePlan = { slides: TemplateSlidePlan[]; warnings: string[] };

const SKIP = new Set(["dt", "ftr", "sldNum"]);
const BODY = new Set(["body", "obj"]);
const isTitle = (p: TemplatePlaceholder) => p.type === "title" || p.type === "ctrTitle";
const bodies = (l: TemplateLayout) => l.placeholders.filter((p) => BODY.has(p.type)).sort((a, b) => (a.x ?? 0) - (b.x ?? 0) || (a.y ?? 0) - (b.y ?? 0));
const content = (l: TemplateLayout) => l.placeholders.filter((p) => !SKIP.has(p.type));
const area = (p: TemplatePlaceholder) => (p.w === undefined ? 0 : p.w * (p.h ?? 0));

type Role = "cover" | "section" | "content" | "two" | "titleOnly" | "blank" | "closing";

const NAME_HINTS: Partial<Record<Role, RegExp>> = {
	closing: /obrigad|thank|encerr|fim\b|the end|closing|contato|contact/i,
	section: /se[cç][aã]o|section|divisor|divider|cap[ií]tulo|chapter/i,
};

/** Layout do modelo para um papel; `undefined` quando o modelo não tem nada parecido. */
function layoutFor(info: TemplateInfo, role: Role): TemplateLayout | undefined {
	const all = info.layouts;
	const named = NAME_HINTS[role] ? all.find((l) => NAME_HINTS[role]!.test(l.name)) : undefined;
	if (named) return named;
	switch (role) {
		case "cover":
		case "closing": {
			const byKind = all.find((l) => l.kind === "title") ?? all.find((l) => l.placeholders.some((p) => p.type === "ctrTitle"));
			return byKind ?? all.find((l) => l.placeholders.some(isTitle) && l.placeholders.some((p) => p.type === "subTitle")) ?? all[0];
		}
		case "section":
			return all.find((l) => l.kind === "secHead") ?? all.find((l) => l.kind === "title") ?? all.find((l) => l.placeholders.some(isTitle) && bodies(l).length >= 1 && bodies(l).length < 2);
		case "content":
			return all.find((l) => l.kind === "obj") ?? all.find((l) => l.placeholders.some(isTitle) && bodies(l).length === 1) ?? all.find((l) => l.placeholders.some(isTitle) && bodies(l).length >= 1);
		case "two":
			return all.find((l) => (l.kind === "twoObj" || l.kind === "twoTxTwoObj") && bodies(l).length >= 2) ?? all.find((l) => l.placeholders.some(isTitle) && bodies(l).length === 2);
		case "titleOnly":
			return all.find((l) => l.kind === "titleOnly") ?? all.find((l) => content(l).length === 1 && l.placeholders.some(isTitle));
		case "blank":
			return all.find((l) => l.kind === "blank") ?? all.find((l) => content(l).length === 0);
	}
}

/** Escolhe o layout do slide. `hint` (nome do layout) vence, quando existe no modelo. */
export function chooseLayout(info: TemplateInfo, slide: SlideInput, hint?: string): { layout: TemplateLayout; role: Role } {
	const named = hint ? info.layouts.find((l) => l.name.toLowerCase() === hint.trim().toLowerCase()) : undefined;
	const roles: Role[] = ((): Role[] => {
		switch (slide.layout) {
			case "title":
				return ["cover"];
			case "section":
				return ["section", "cover"];
			case "closing":
				return ["closing", "cover"];
			case "bullets":
			case "agenda":
				return ["content", "two", "titleOnly"];
			case "two_column":
				return ["two", "titleOnly", "content"];
			case "free":
				return ["blank", "titleOnly", "content"];
			default:
				return ["titleOnly", "content", "blank"];
		}
	})();
	if (named) return { layout: named, role: roles[0]! };
	for (const role of roles) {
		const layout = layoutFor(info, role);
		if (layout) return { layout, role };
	}
	return { layout: info.layouts[0]!, role: roles[0]! };
}

/** Paleta do modelo em tokens do deck (para ícones, fundos e o ajuste de contraste). */
export function templatePalette(info: TemplateInfo): DeckPalette {
	const c = info.theme.colors;
	const base = buildPalette("clean");
	const bg = c.lt1 ?? base.bg;
	const text = c.dk1 ?? base.text;
	const accent = c.accent1 ?? base.accent;
	const accent2 = c.accent2 ?? base.accent2;
	const coverBg = c.dk2 ?? mixColors(accent, "000000", 0.5);
	return {
		...base,
		bg,
		text,
		accent,
		accent2,
		surface: mixColors(bg, text, 0.06),
		border: mixColors(bg, text, 0.18),
		muted: mixColors(text, bg, 0.4),
		onAccent: readableOn(accent),
		coverBg,
		coverAccent: accent2,
		coverMuted: mixColors(readableOn(coverBg), coverBg, 0.3),
		headFont: info.theme.majorFont ?? base.headFont,
		bodyFont: info.theme.minorFont ?? base.bodyFont,
		series: [accent, accent2, c.accent3 ?? mixColors(accent, "FFFFFF", 0.3), c.accent4 ?? mixColors(accent2, "000000", 0.3), c.accent5 ?? mixColors(accent, "000000", 0.4), c.accent6 ?? mixColors(accent2, "FFFFFF", 0.5)],
	};
}

const toLines = (bullets: DeckBullet[]): FillLine[] => bullets.flatMap((b) => [{ text: b.text, level: 0 }, ...b.sub.map((s) => ({ text: s, level: 1 }))]);

function placeholderFor(layout: TemplateLayout, pick: (p: TemplatePlaceholder) => boolean): TemplatePlaceholder | undefined {
	return layout.placeholders.find(pick);
}

/** Área livre do slide: o maior placeholder de conteúdo (quando não é usado para texto) ou o espaço abaixo do título. */
function freeArea(info: TemplateInfo, layout: TemplateLayout): Area {
	const k = info.widthIn / 13.333;
	const body = [...bodies(layout), ...layout.placeholders.filter((p) => p.type === "pic" || p.type === "chart" || p.type === "tbl")].sort((a, b) => area(b) - area(a))[0];
	if (body && body.w !== undefined && body.w > info.widthIn * 0.4) return { x: body.x ?? 0, y: body.y ?? 0, w: body.w, h: body.h ?? 0 };
	const title = placeholderFor(layout, isTitle);
	const x = title?.x ?? 0.07 * info.widthIn;
	const w = title?.w && title.w > info.widthIn * 0.4 ? title.w : info.widthIn - 2 * x;
	const top = title?.y !== undefined && title.h !== undefined ? title.y + title.h + 0.2 * k : 1.9 * (info.heightIn / 7.5);
	return { x, y: top, w, h: Math.max(1.5, info.heightIn - top - 0.65 * (info.heightIn / 7.5)) };
}

function toPlanned(el: FreeElement, p: DeckPalette): PlannedElement {
	if (el.type === "image") return { type: "picture", asset: `image:${el.image}`, x: el.x, y: el.y, w: el.w, h: el.h, fit: el.fit };
	if (el.type === "icon") return { type: "picture", asset: iconKey(el.name, resolveDeckColor(el.color ?? "text", p)), x: el.x, y: el.y, w: el.w, h: el.h, fit: "contain", alt: el.name };
	if (el.type === "chart") {
		const spec = el.chart;
		const data = chartSeriesData(spec);
		const kind = spec.type === "pie" || spec.type === "line" || spec.type === "area" ? spec.type : "bar";
		return {
			type: "chart", x: el.x, y: el.y, w: el.w, h: el.h, kind,
			horizontal: spec.orientation === "horizontal", stacked: spec.stacked === true,
			labels: data[0]?.labels ?? [], series: data.map((s) => ({ name: s.name, values: s.values })), numberFormat: chartNumberFormat(spec),
		};
	}
	if (el.type === "table") {
		const align = el.columns.map((_, c) => (el.rows.every((r) => !r[c] || NUMBER_LIKE.test(r[c]!)) ? ("right" as const) : ("left" as const)));
		const size = Math.max(9, Math.min(el.rows.length > 9 ? 12 : el.rows.length > 6 ? 14 : 18, Math.floor((el.h / (el.rows.length + 1)) * 72 * 0.55)));
		return { type: "table", x: el.x, y: el.y, w: el.w, h: el.h, columns: el.columns, rows: el.rows, align, size };
	}
	return el;
}

type ColorMap = (color: string | undefined) => string | undefined;

/** Resolve tokens de cor para hex (usado quando o fundo escolhido obriga a trocar as cores do tema). */
function resolveColors(el: PlannedElement, map: ColorMap): PlannedElement {
	if (el.type === "picture" || el.type === "chart" || el.type === "table") return el;
	if (el.type === "text") return { ...el, ...(el.color ? { color: map(el.color) } : { color: map("text") }) };
	return {
		...el,
		...(el.fill ? { fill: map(el.fill) } : {}),
		...(el.stroke ? { stroke: map(el.stroke) } : {}),
		...(el.textColor ? { textColor: map(el.textColor) } : {}),
	};
}

export type PlanOptions = { hints?: ReadonlyArray<string | undefined> };

export function planTemplateDeck(slides: readonly SlideInput[], info: TemplateInfo, options: PlanOptions = {}): TemplatePlan {
	const warnings: string[] = [];
	const sx = info.widthIn / 13.333;
	const sy = info.heightIn / 7.5;
	const k = Math.min(sx, sy);
	const base = templatePalette(info);
	const planned = slides.map((slide, index): TemplateSlidePlan => {
		const { layout, role } = chooseLayout(info, slide, options.hints?.[index]);
		const fills: PlannedFill[] = [];
		let elements: FreeElement[] = [];
		const titlePh = placeholderFor(layout, isTitle);
		const setTitle = (value: string | undefined) => {
			if (value && titlePh) fills.push({ idx: titlePh.idx, lines: [{ text: value, level: 0 }] });
			else if (value && !titlePh) warnings.push(`slide ${index + 1}: layout "${layout.name}" has no title placeholder, so the title was drawn as a text box.`);
		};
		const bodyPhs = bodies(layout);
		const drawTitleFallback = (value: string | undefined): FreeElement[] =>
			value && !titlePh ? [{ type: "text", x: 0.07 * info.widthIn, y: 0.4 * sy, w: 0.86 * info.widthIn, h: 1.0 * sy, text: value, size: Math.round(34 * k), bold: true, align: "left", valign: "middle", font: "heading" }] : [];
		switch (slide.layout) {
			case "title":
			case "section": {
				setTitle(slide.title);
				const sub = layout.placeholders.find((p) => p.type === "subTitle") ?? bodyPhs[0];
				if (slide.subtitle && sub) fills.push({ idx: sub.idx, lines: [{ text: slide.subtitle, level: 0 }] });
				else if (slide.subtitle) elements.push({ type: "text", x: 0.07 * info.widthIn, y: 0.6 * info.heightIn, w: 0.8 * info.widthIn, h: 0.9 * sy, text: slide.subtitle, size: Math.round(22 * k), align: "left", valign: "top" });
				elements.unshift(...drawTitleFallback(slide.title));
				break;
			}
			case "closing": {
				setTitle(slide.title);
				const sub = layout.placeholders.find((p) => p.type === "subTitle") ?? bodyPhs[0];
				const lines: FillLine[] = [...(slide.subtitle ? [{ text: slide.subtitle, level: 0 }] : []), ...toLines(slide.bullets)];
				if (lines.length && sub) fills.push({ idx: sub.idx, lines });
				else if (lines.length) elements.push(...semanticElements({ ...slide, bullets: [...(slide.subtitle ? [{ text: slide.subtitle, sub: [] }] : []), ...slide.bullets] }, freeArea(info, layout), k));
				elements.unshift(...drawTitleFallback(slide.title));
				break;
			}
			case "bullets": {
				setTitle(slide.title);
				if (bodyPhs[0] && bodyPhs.length === 1) fills.push({ idx: bodyPhs[0].idx, lines: toLines(slide.bullets) });
				else elements.push(...semanticElements(slide, freeArea(info, layout), k));
				elements.unshift(...drawTitleFallback(slide.title));
				break;
			}
			case "agenda": {
				setTitle(slide.title);
				if (bodyPhs[0] && bodyPhs.length === 1) fills.push({ idx: bodyPhs[0].idx, lines: slide.items.map((text, i) => ({ text: `${i + 1}. ${text}`, level: 0 })) });
				else elements.push(...semanticElements(slide, freeArea(info, layout), k));
				elements.unshift(...drawTitleFallback(slide.title));
				break;
			}
			case "two_column": {
				setTitle(slide.title);
				if (role === "two" && bodyPhs.length >= 2) {
					slide.columns.forEach((col, i) => fills.push({ idx: bodyPhs[i]!.idx, lines: [...(col.heading ? [{ text: col.heading, level: 0, bold: true }] : []), ...toLines(col.bullets)] }));
				} else elements.push(...semanticElements(slide, freeArea(info, layout), k));
				elements.unshift(...drawTitleFallback(slide.title));
				break;
			}
			case "quote": {
				if (slide.title) setTitle(slide.title);
				elements.push(...semanticElements(slide, freeArea(info, layout), k));
				if (slide.title) elements.unshift(...drawTitleFallback(slide.title));
				break;
			}
			case "free": {
				elements = slide.elements.map((el) => scaleFreeElement(el, sx, sy));
				break;
			}
			default: {
				setTitle(slide.title);
				elements.push(...semanticElements(slide, freeArea(info, layout), k));
				elements.unshift(...drawTitleFallback(slide.title));
			}
		}
		// Fundo escolhido: troca as cores de tema por hex adaptado e força o texto dos placeholders.
		let background: PlannedBackground | undefined;
		let ink: string | undefined;
		let map: ColorMap | undefined;
		let slidePalette = base;
		const cover = slide.layout === "title" || slide.layout === "section" || slide.layout === "closing";
		if (slide.background) {
			const backdrop = resolveBackdrop(slide.background, cover, base);
			const adapted = adaptPalette(base, cover, backdrop);
			slidePalette = adapted;
			const bg = slide.background;
			if (bg.kind === "color") background = { kind: "color", color: resolveDeckColor(bg.color, base) };
			else if (bg.kind === "gradient") background = { kind: "picture", asset: `gradient:${index}` };
			else background = { kind: "picture", asset: `background:${index}`, ...(backdrop?.scrim ? { scrim: backdrop.scrim } : {}) };
			const dark = backdrop?.dark ?? false;
			ink = cover ? (dark ? "FFFFFF" : "111827") : adapted.text;
			map = (color) => (color === undefined ? undefined : resolveDeckColor(color, cover ? { ...adapted, text: ink!, muted: adapted.muted } : adapted));
		}
		const final = elements.map((el) => toPlanned(el, slidePalette)).map((el) => (map ? resolveColors(el, map) : el));
		return { master: layout.master, layout: layout.index, layoutName: layout.name, fills, elements: final, ...(background ? { background } : {}), ...(ink ? { ink } : {}), ...(slide.notes ? { notes: slide.notes } : {}) };
	});
	return { slides: planned, warnings };
}
