import type pptxgen from "pptxgenjs";
import type { ChartSpec, DeckBullet, SlideInput } from "@workspace/shared";
import { backgroundKey, gradientKey, type DeckAssets } from "./assets.js";
import { resolveDeckColor, slideStyle } from "./backdrop.js";
import { drawFree } from "./free.js";
import { chartColors, chartNumberFormat, chartSeriesData } from "./charts.js";
import type { DeckImage } from "./images.js";
import type { DeckPalette } from "./themes.js";

type Pptx = InstanceType<typeof pptxgen.default>;
type Slide = ReturnType<Pptx["addSlide"]>;
type TextRun = Exclude<Parameters<Slide["addText"]>[0], string>[number];

/** Página 16:9 em polegadas (LAYOUT_WIDE) e margens comuns a todos os layouts. */
export const PAGE_W = 13.333;
export const PAGE_H = 7.5;
export const MARGIN = 0.65;
export const CONTENT_W = PAGE_W - MARGIN * 2;
const BODY_TOP = 1.75;
const BODY_BOTTOM = 6.75;
/** Área do corpo dos slides de conteúdo (para a conferência de layout). */
export const BODY_TOP_IN = BODY_TOP;
export const BODY_BOTTOM_IN = BODY_BOTTOM;

/** `palette` é a do slide atual (já adaptada ao fundo); `base` é a do tema, de onde saem os tokens do fundo. */
export type DeckContext = { pptx: Pptx; palette: DeckPalette; base: DeckPalette; images: Map<string, DeckImage>; sectionCount: { n: number }; assets: DeckAssets; slideIndex: number };

export type Box = { x: number; y: number; w: number; h: number };

/** Tamanho do texto de lista pelo volume (não há autoajuste confiável fora do PowerPoint). */
export function bodyFontSize(bullets: DeckBullet[], width = CONTENT_W): number {
	const chars = bullets.reduce((sum, b) => sum + b.text.length + b.sub.reduce((s, x) => s + x.length, 0), 0);
	const lines = bullets.length + bullets.reduce((s, b) => s + b.sub.length, 0);
	const density = chars * (12.1 / width) + lines * 40;
	if (density <= 260) return 28;
	if (density <= 420) return 24;
	if (density <= 620) return 20;
	return 16;
}

function bulletRuns(bullets: DeckBullet[], size: number, p: DeckPalette): TextRun[] {
	const runs: TextRun[] = [];
	for (const b of bullets) {
		runs.push({
			text: b.text,
			options: { bullet: { characterCode: "25A0", indent: 22 }, breakLine: true, fontSize: size, color: p.text, paraSpaceAfter: b.sub.length ? 3 : 10, fontFace: p.bodyFont },
		});
		for (const sub of b.sub) {
			runs.push({
				text: sub,
				options: { bullet: { characterCode: "2013", indent: 20 }, indentLevel: 1, breakLine: true, fontSize: Math.max(12, size - 4), color: p.muted, paraSpaceAfter: 6, fontFace: p.bodyFont },
			});
		}
	}
	return runs;
}

function slideTitle(slide: Slide, title: string, p: DeckPalette): void {
	const size = title.length > 70 ? 26 : title.length > 48 ? 30 : 36;
	slide.addText(title, { x: MARGIN, y: 0.5, w: CONTENT_W, h: 1.0, fontSize: size, bold: true, color: p.text, fontFace: p.headFont, valign: "middle", margin: 0, fit: "shrink" });
	slide.addShape("rect", { x: MARGIN, y: 1.52, w: 0.9, h: 0.06, fill: { color: p.accent }, line: { color: p.accent, width: 0 } });
}

function caption(slide: Slide, text: string | undefined, p: DeckPalette, y = 6.3): void {
	if (!text) return;
	slide.addText(text, { x: MARGIN, y, w: CONTENT_W, h: 0.45, fontSize: 14, italic: true, color: p.muted, fontFace: p.bodyFont, valign: "top", margin: 0 });
}

/** Maior retângulo com a proporção da imagem dentro da caixa, centralizado. */
export function fitInside(box: { x: number; y: number; w: number; h: number }, image: { width: number; height: number }): { x: number; y: number; w: number; h: number } {
	const scale = Math.min(box.w / image.width, box.h / image.height);
	const w = image.width * scale;
	const h = image.height * scale;
	return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

type Draw<T extends SlideInput["layout"]> = (ctx: DeckContext, slide: Slide, input: Extract<SlideInput, { layout: T }>) => void;

/** Círculos translúcidos das capas (mestre só aceita retângulos, então ficam no slide). */
function coverDecor(slide: Slide, p: DeckPalette, kind: "cover" | "section"): void {
	if (kind === "cover") {
		slide.addShape("ellipse", { x: 8.6, y: -2.4, w: 7.4, h: 7.4, fill: { color: p.accent, transparency: 72 }, line: { color: p.accent, width: 0, transparency: 100 } });
		slide.addShape("ellipse", { x: 10.9, y: 4.6, w: 4.2, h: 4.2, fill: { color: p.coverAccent, transparency: 80 }, line: { color: p.coverAccent, width: 0, transparency: 100 } });
	} else {
		slide.addShape("ellipse", { x: 9.4, y: -1.6, w: 6.2, h: 6.2, fill: { color: p.coverAccent, transparency: 80 }, line: { color: p.coverAccent, width: 0, transparency: 100 } });
		slide.addShape("rect", { x: 0, y: 0, w: 0.28, h: PAGE_H, fill: { color: p.accent }, line: { color: p.accent, width: 0 } });
	}
}

const drawTitle: Draw<"title"> = ({ palette: p }, slide, input) => {
	coverDecor(slide, p, "cover");
	slide.addText(input.title, { x: MARGIN, y: 1.8, w: 9.2, h: 2.4, fontSize: input.title.length > 50 ? 42 : 54, bold: true, color: p.coverText, fontFace: p.headFont, valign: "bottom", margin: 0, fit: "shrink" });
	slide.addShape("rect", { x: MARGIN, y: 4.4, w: 1.4, h: 0.09, fill: { color: p.coverAccent }, line: { color: p.coverAccent, width: 0 } });
	if (input.subtitle) slide.addText(input.subtitle, { x: MARGIN, y: 4.7, w: 8.6, h: 1.1, fontSize: 24, color: p.coverMuted, fontFace: p.bodyFont, valign: "top", margin: 0 });
};

const drawSection: Draw<"section"> = ({ palette: p, sectionCount }, slide, input) => {
	coverDecor(slide, p, "section");
	sectionCount.n += 1;
	slide.addText(String(sectionCount.n).padStart(2, "0"), { x: MARGIN, y: 1.9, w: 4, h: 1.5, fontSize: 88, bold: true, color: p.coverAccent, fontFace: p.headFont, margin: 0 });
	slide.addText(input.title, { x: MARGIN, y: 3.5, w: 9.5, h: 1.3, fontSize: input.title.length > 40 ? 38 : 48, bold: true, color: p.coverText, fontFace: p.headFont, valign: "top", margin: 0, fit: "shrink" });
	if (input.subtitle) slide.addText(input.subtitle, { x: MARGIN, y: 4.85, w: 8.6, h: 0.9, fontSize: 22, color: p.coverMuted, fontFace: p.bodyFont, valign: "top", margin: 0 });
};

const drawAgenda: Draw<"agenda"> = ({ palette: p }, slide, input) => {
	slideTitle(slide, input.title, p);
	const rowH = Math.min(0.78, (BODY_BOTTOM - BODY_TOP) / input.items.length);
	input.items.forEach((item, i) => {
		const y = BODY_TOP + 0.1 + i * rowH;
		slide.addShape("ellipse", { x: MARGIN, y, w: 0.5, h: 0.5, fill: { color: p.accent }, line: { color: p.accent, width: 0 } });
		slide.addText(String(i + 1), { x: MARGIN, y, w: 0.5, h: 0.5, fontSize: 18, bold: true, color: p.onAccent, align: "center", valign: "middle", margin: 0, fontFace: p.headFont });
		slide.addText(item, { x: MARGIN + 0.8, y: y - 0.02, w: CONTENT_W - 0.8, h: 0.54, fontSize: 26, color: p.text, valign: "middle", margin: 0, fontFace: p.bodyFont, fit: "shrink" });
	});
};

const drawBullets: Draw<"bullets"> = ({ palette: p }, slide, input) => {
	slideTitle(slide, input.title, p);
	if (input.bullets.length === 0) return;
	slide.addText(bulletRuns(input.bullets, bodyFontSize(input.bullets), p), { x: MARGIN, y: BODY_TOP, w: CONTENT_W, h: BODY_BOTTOM - BODY_TOP, valign: "top", margin: 0, fit: "shrink" });
};

const drawTwoColumn: Draw<"two_column"> = ({ palette: p }, slide, input) => {
	slideTitle(slide, input.title, p);
	const gap = 0.4;
	const w = (CONTENT_W - gap) / 2;
	const size = Math.min(22, ...input.columns.map((c) => bodyFontSize(c.bullets, w - 0.6)));
	const charsPerLine = Math.max(10, Math.floor(((w - 0.9) * 72) / (size * 0.5)));
	const lines = Math.max(...input.columns.map((c) => c.bullets.reduce((n, b) => n + Math.ceil(b.text.length / charsPerLine) + b.sub.length, 0)));
	const cardH = Math.min(BODY_BOTTOM - BODY_TOP, Math.max(3.2, 1.5 + lines * ((size * 1.25 + 10) / 72)));
	input.columns.forEach((col, i) => {
		const x = MARGIN + i * (w + gap);
		slide.addShape("roundRect", { x, y: BODY_TOP, w, h: cardH, fill: { color: p.surface }, line: { color: p.border, width: 0.75 }, rectRadius: 0.12 });
		slide.addShape("rect", { x: x + 0.3, y: BODY_TOP + 0.3, w: 0.6, h: 0.06, fill: { color: i === 0 ? p.accent : p.accent2 }, line: { color: i === 0 ? p.accent : p.accent2, width: 0 } });
		let top = BODY_TOP + 0.5;
		if (col.heading) {
			slide.addText(col.heading, { x: x + 0.3, y: top, w: w - 0.6, h: 0.6, fontSize: 26, bold: true, color: p.text, fontFace: p.headFont, margin: 0, valign: "middle", fit: "shrink" });
			top += 0.8;
		}
		if (col.bullets.length > 0) {
			slide.addText(bulletRuns(col.bullets, size, p), { x: x + 0.3, y: top, w: w - 0.6, h: BODY_TOP + cardH - top - 0.25, valign: "top", margin: 0, fit: "shrink" });
		}
	});
};

const drawImage: Draw<"image"> = ({ palette: p, images }, slide, input) => {
	slideTitle(slide, input.title, p);
	const image = images.get(input.image);
	if (!image) throw new Error(`Image ${input.image} was not resolved.`);
	const hasText = input.bullets.length > 0;
	const bottom = input.caption ? 6.25 : BODY_BOTTOM;
	const box = { x: MARGIN, y: BODY_TOP, w: hasText ? 7.3 : CONTENT_W, h: bottom - BODY_TOP };
	const rect = fitInside(box, image);
	slide.addImage({ data: image.data, ...rect });
	if (hasText) {
		slide.addText(bulletRuns(input.bullets, Math.min(24, bodyFontSize(input.bullets, 4.5)), p), { x: 8.4, y: BODY_TOP, w: PAGE_W - MARGIN - 8.4, h: BODY_BOTTOM - BODY_TOP, valign: "top", margin: 0, fit: "shrink" });
	}
	caption(slide, input.caption, p, 6.35);
};

/** Gráfico nativo do PowerPoint dentro de `area` (usado pelo layout `chart` e pelo elemento livre). */
export function placeChart(pptx: Pptx, slide: Slide, spec: ChartSpec, area: Box, p: DeckPalette): void {
	const data = chartSeriesData(spec);
	const format = chartNumberFormat(spec);
	const manySeries = spec.series.length > 1;
	const common = {
		...area,
		showTitle: false,
		catAxisLabelColor: p.muted,
		valAxisLabelColor: p.muted,
		catAxisLabelFontSize: 13,
		valAxisLabelFontSize: 12,
		catAxisLabelFontFace: p.bodyFont,
		valAxisLabelFontFace: p.bodyFont,
		valAxisLabelFormatCode: format,
		valGridLine: { color: p.border, size: 0.75, style: "solid" as const },
		catGridLine: { style: "none" as const },
		showLegend: manySeries,
		legendPos: "b" as const,
		legendFontSize: 13,
		legendColor: p.text,
		legendFontFace: p.bodyFont,
		dataLabelFontSize: 12,
		dataLabelColor: p.text,
		dataLabelFormatCode: format,
	};
	const colors = chartColors(p, spec.type === "pie" ? spec.data.length : spec.series.length);
	const showValues = spec.data.length <= 12;
	if (spec.type === "pie") {
		slide.addChart(pptx.ChartType.pie, data, {
			...area,
			showTitle: false,
			chartColors: colors,
			showLegend: true,
			legendPos: "r",
			legendFontSize: 14,
			legendColor: p.text,
			legendFontFace: p.bodyFont,
			showPercent: true,
			showValue: false,
			dataLabelColor: p.onAccent,
			dataLabelFontSize: 13,
			dataLabelFormatCode: "0%",
			dataBorder: { pt: 1.5, color: p.bg },
		});
	} else if (spec.type === "line") {
		slide.addChart(pptx.ChartType.line, data, { ...common, chartColors: colors, lineSize: 3, lineDataSymbolSize: 8, showValue: showValues && !manySeries, dataLabelPosition: "t" });
	} else if (spec.type === "area") {
		slide.addChart(pptx.ChartType.area, data, { ...common, chartColors: colors, showValue: false, barGrouping: spec.stacked ? "stacked" : "standard", valAxisLabelFormatCode: format });
	} else {
		slide.addChart(pptx.ChartType.bar, data, {
			...common,
			chartColors: colors,
			barDir: spec.orientation === "horizontal" ? "bar" : "col",
			barGrouping: spec.stacked ? "stacked" : "clustered",
			barGapWidthPct: 60,
			showValue: showValues && !spec.stacked,
			dataLabelPosition: spec.stacked ? undefined : "outEnd",
		});
	}
}

const drawChart: Draw<"chart"> = ({ pptx, palette: p }, slide, input) => {
	slideTitle(slide, input.title, p);
	const area = { x: MARGIN, y: BODY_TOP - 0.1, w: CONTENT_W, h: (input.caption ? 6.25 : BODY_BOTTOM + 0.1) - BODY_TOP + 0.1 };
	placeChart(pptx, slide, input.chart, area, p);
	caption(slide, input.caption, p);
};

const NUMBER_LIKE = /^[-+−–R$US€\s\d.,%()]+$/;

/** Tabela nativa dentro de `box`; o tamanho da letra acompanha o número de linhas e a altura disponível. */
export function placeTable(slide: Slide, p: DeckPalette, columns: string[], rows: string[][], box: Box): void {
	const rowH = Math.min(0.72, box.h / (rows.length + 1));
	const size = Math.min(rows.length > 9 ? 13 : rows.length > 6 ? 16 : 20, Math.max(9, Math.floor(rowH * 72 * 0.6)));
	const align = columns.map((_, c) => (rows.length > 0 && rows.every((r) => !r[c] || NUMBER_LIKE.test(r[c]!)) ? ("right" as const) : ("left" as const)));
	const cell = (text: string, c: number, fill: string, color: string, bold = false) => ({
		text,
		options: { fontSize: size, bold, color, fill: { color: fill }, align: align[c], valign: "middle" as const, fontFace: p.bodyFont, margin: [0.04, 0.12, 0.04, 0.12] as [number, number, number, number] },
	});
	const header = columns.map((name, c) => cell(name, c, p.accent, p.onAccent, true));
	const body = rows.map((row, r) => row.map((text, c) => cell(text, c, r % 2 === 0 ? p.bg : p.surface, p.text, c === 0)));
	slide.addTable([header, ...body], { x: box.x, y: box.y, w: box.w, rowH, border: { type: "solid", pt: 0.5, color: p.border }, autoPage: false });
}

const drawTable: Draw<"table"> = ({ palette: p }, slide, input) => {
	slideTitle(slide, input.title, p);
	placeTable(slide, p, input.columns, input.rows, { x: MARGIN, y: BODY_TOP, w: CONTENT_W, h: 6.2 - BODY_TOP });
	caption(slide, input.caption, p, 6.4);
};

const drawQuote: Draw<"quote"> = ({ palette: p }, slide, input) => {
	slide.addShape("rect", { x: 0, y: 0, w: 0.28, h: PAGE_H, fill: { color: p.accent }, line: { color: p.accent, width: 0 } });
	if (input.title) slide.addText(input.title, { x: MARGIN, y: 0.5, w: CONTENT_W, h: 0.6, fontSize: 18, bold: true, color: p.accent, fontFace: p.headFont, margin: 0, charSpacing: 2 });
	slide.addText("“", { x: MARGIN, y: 1.2, w: 2, h: 1.8, fontSize: 130, bold: true, color: p.accent, fontFace: "Georgia", margin: 0, valign: "top" });
	const size = input.quote.length > 220 ? 28 : input.quote.length > 120 ? 34 : 40;
	slide.addText(input.quote, { x: MARGIN + 0.2, y: 2.4, w: CONTENT_W - 1.2, h: 3.0, fontSize: size, italic: true, color: p.text, fontFace: "Georgia", valign: "top", margin: 0, fit: "shrink" });
	if (input.author) {
		slide.addShape("rect", { x: MARGIN + 0.2, y: 5.65, w: 0.7, h: 0.05, fill: { color: p.accent2 }, line: { color: p.accent2, width: 0 } });
		slide.addText(input.author, { x: MARGIN + 0.2, y: 5.8, w: CONTENT_W - 1.2, h: 0.5, fontSize: 18, color: p.muted, fontFace: p.bodyFont, margin: 0 });
	}
};

function deltaColor(text: string, p: DeckPalette): string {
	if (/^\s*\+/.test(text)) return p.positive;
	if (/^\s*[-−–]/.test(text)) return p.negative;
	return p.muted;
}

const drawStats: Draw<"stats"> = ({ palette: p }, slide, input) => {
	slideTitle(slide, input.title, p);
	const n = input.stats.length;
	const gap = 0.35;
	const w = (CONTENT_W - gap * (n - 1)) / n;
	const h = 3.5;
	const y = 2.2;
	input.stats.forEach((stat, i) => {
		const x = MARGIN + i * (w + gap);
		slide.addShape("roundRect", { x, y, w, h, fill: { color: p.surface }, line: { color: p.border, width: 0.75 }, rectRadius: 0.12 });
		slide.addShape("rect", { x: x + 0.3, y: y + 0.3, w: 0.6, h: 0.07, fill: { color: i % 2 === 0 ? p.accent : p.accent2 }, line: { color: p.accent, width: 0 } });
		const tight = n >= 3;
		const valueSize = stat.value.length > 12 ? 26 : stat.value.length > 8 ? (tight ? 30 : 40) : n === 1 ? 80 : stat.value.length > 5 ? (tight ? 40 : 54) : tight ? 54 : 64;
		slide.addText(stat.value, { x: x + 0.3, y: y + 0.55, w: w - 0.6, h: 1.4, fontSize: valueSize, bold: true, color: p.accent, fontFace: p.bodyFont, valign: "middle", margin: 0, fit: "shrink" });
		slide.addText(stat.label, { x: x + 0.3, y: y + 2.0, w: w - 0.6, h: 0.75, fontSize: n >= 4 ? 18 : 22, color: p.text, fontFace: p.bodyFont, valign: "top", margin: 0, fit: "shrink" });
		if (stat.detail) slide.addText(stat.detail, { x: x + 0.3, y: y + 2.8, w: w - 0.6, h: 0.5, fontSize: 17, bold: true, color: deltaColor(stat.detail, p), fontFace: p.bodyFont, valign: "top", margin: 0 });
	});
	caption(slide, input.caption, p, 6.1);
};

const drawTimeline: Draw<"timeline"> = ({ palette: p }, slide, input) => {
	slideTitle(slide, input.title, p);
	const n = input.steps.length;
	const w = CONTENT_W / n;
	const lineY = 3.5;
	slide.addShape("rect", { x: MARGIN, y: lineY - 0.02, w: CONTENT_W, h: 0.04, fill: { color: p.border }, line: { color: p.border, width: 0 } });
	input.steps.forEach((step, i) => {
		const cx = MARGIN + w * i + w / 2;
		slide.addText(step.label, { x: cx - w / 2 + 0.1, y: lineY - 0.95, w: w - 0.2, h: 0.5, fontSize: 20, bold: true, color: p.accent, align: "center", valign: "bottom", margin: 0, fontFace: p.headFont });
		slide.addShape("ellipse", { x: cx - 0.2, y: lineY - 0.2, w: 0.4, h: 0.4, fill: { color: i % 2 === 0 ? p.accent : p.accent2 }, line: { color: p.bg, width: 3 } });
		slide.addText(step.title, { x: cx - w / 2 + 0.1, y: lineY + 0.4, w: w - 0.2, h: 0.8, fontSize: n > 4 ? 18 : 22, bold: true, color: p.text, align: "center", valign: "top", margin: 0, fontFace: p.headFont, fit: "shrink" });
		if (step.text) slide.addText(step.text, { x: cx - w / 2 + 0.15, y: lineY + 1.25, w: w - 0.3, h: 1.8, fontSize: n > 4 ? 14 : 16, color: p.muted, align: "center", valign: "top", margin: 0, fontFace: p.bodyFont, fit: "shrink" });
	});
};

const drawClosing: Draw<"closing"> = ({ palette: p }, slide, input) => {
	coverDecor(slide, p, "cover");
	slide.addShape("rect", { x: MARGIN, y: 1.9, w: 1.4, h: 0.09, fill: { color: p.coverAccent }, line: { color: p.coverAccent, width: 0 } });
	slide.addText(input.title, { x: MARGIN, y: 2.15, w: 9.2, h: 1.3, fontSize: input.title.length > 40 ? 40 : 54, bold: true, color: p.coverText, fontFace: p.headFont, valign: "top", margin: 0, fit: "shrink" });
	let y = 3.6;
	if (input.subtitle) {
		slide.addText(input.subtitle, { x: MARGIN, y, w: 9, h: 0.8, fontSize: 24, color: p.coverMuted, fontFace: p.bodyFont, valign: "top", margin: 0 });
		y += 1.05;
	}
	if (input.bullets.length > 0) {
		const runs: TextRun[] = input.bullets.map((b) => ({
			text: b.text,
			options: { bullet: { characterCode: "25A0", indent: 22 }, breakLine: true, fontSize: 24, color: p.coverText, paraSpaceAfter: 10, fontFace: p.bodyFont },
		}));
		slide.addText(runs, { x: MARGIN, y, w: 9.5, h: 6.9 - y, valign: "top", margin: 0, fit: "shrink" });
	}
};

const DRAWERS: { [K in SlideInput["layout"]]: Draw<K> } = {
	title: drawTitle,
	agenda: drawAgenda,
	section: drawSection,
	bullets: drawBullets,
	two_column: drawTwoColumn,
	image: drawImage,
	chart: drawChart,
	table: drawTable,
	quote: drawQuote,
	stats: drawStats,
	timeline: drawTimeline,
	closing: drawClosing,
	free: drawFree,
};

/** Qual fundo (slide master) cada layout usa. */
export function masterFor(layout: SlideInput["layout"]): "COVER" | "SECTION" | "CONTENT" | "QUOTE" | "FREE" {
	if (layout === "free") return "FREE";
	if (layout === "title" || layout === "closing") return "COVER";
	if (layout === "section") return "SECTION";
	if (layout === "quote") return "QUOTE";
	return "CONTENT";
}

/** Fundo do slide (cor, gradiente ou foto) e o véu de legibilidade sobre fotos. Vem antes de qualquer desenho. */
function applyBackground(ctx: DeckContext, slide: Slide, input: SlideInput): void {
	const bg = input.background;
	if (!bg) return;
	if (bg.kind === "color") slide.background = { color: resolveDeckColor(bg.color, ctx.base) };
	else if (bg.kind === "gradient") slide.background = { data: ctx.assets.get(gradientKey(ctx.slideIndex)) };
	else {
		slide.background = { data: ctx.assets.get(backgroundKey(ctx.slideIndex)) };
		const scrim = slideStyle(ctx.base, input).backdrop?.scrim;
		if (scrim) {
			slide.addShape("rect", {
				x: 0,
				y: 0,
				w: PAGE_W,
				h: PAGE_H,
				fill: { color: scrim.color, transparency: Math.round((1 - scrim.opacity) * 100) },
				line: { color: scrim.color, width: 0, transparency: 100 },
			});
		}
	}
}

export function drawSlide(ctx: DeckContext, slide: Slide, input: SlideInput): void {
	applyBackground(ctx, slide, input);
	(DRAWERS[input.layout] as Draw<typeof input.layout>)(ctx, slide, input as never);
	if (input.notes) slide.addNotes(input.notes);
}
