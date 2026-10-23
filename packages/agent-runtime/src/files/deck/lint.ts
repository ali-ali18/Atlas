import type { DeckBullet, DeckTheme, FreeElement, FreeText, SlideInput } from "@workspace/shared";
import { resolveDeckColor, slideStyle } from "./backdrop.js";
import { bodyFontSize, BODY_BOTTOM_IN, BODY_TOP_IN, CONTENT_W } from "./layouts.js";
import { buildPalette, contrastRatio, type DeckPalette } from "./themes.js";

/**
 * Conferência barata do deck, sem renderizar: estima se o texto cabe na caixa, aponta sobreposição,
 * contraste baixo e fundo de foto sem véu. As estimativas usam a largura média de uma fonte sans
 * (0,52 do corpo por caractere) e linha de 1,2: erram para pouco, então só avisam quando falta bastante.
 * Os avisos voltam ao modelo no resultado do `create_file`, para ele corrigir antes de entregar.
 */
export type DeckWarning = { slide: number; message: string };

const CHAR_W = 0.52;
const LINE_H = 1.2;
const OVERFLOW_TOLERANCE = 1.08;
const MIN_READABLE_PT = 12;
const DENSE_WORDS = 130;

/** Linhas que `text` ocupa numa caixa de `widthIn` com fonte `sizePt` (quebra por palavra aproximada). */
export function estimateLines(text: string, widthIn: number, sizePt: number): number {
	const perLine = Math.max(4, Math.floor((widthIn * 72) / (sizePt * CHAR_W)));
	return text.split(/\r?\n/).reduce((sum, paragraph) => {
		if (!paragraph.trim()) return sum + 1;
		let lines = 1;
		let used = 0;
		for (const word of paragraph.split(/\s+/)) {
			const len = word.length;
			if (len > perLine) {
				lines += Math.ceil((used + len) / perLine) - (used > 0 ? 0 : 1);
				used = (used + len) % perLine;
			} else if (used === 0) used = len;
			else if (used + 1 + len <= perLine) used += 1 + len;
			else {
				lines += 1;
				used = len;
			}
		}
		return sum + lines;
	}, 0);
}

/** Altura (pol.) do texto com `sizePt`, mais `gapPt` entre parágrafos. */
export function estimateTextHeight(text: string, widthIn: number, sizePt: number, gapPt = 0): number {
	const paragraphs = text.split(/\r?\n/).length;
	return (estimateLines(text, widthIn, sizePt) * sizePt * LINE_H + paragraphs * gapPt) / 72;
}

const snippet = (text: string) => `"${text.replace(/\s+/g, " ").trim().slice(0, 40)}${text.length > 40 ? "…" : ""}"`;
const inches = (n: number) => `${(Math.round(n * 10) / 10).toFixed(1)} in`;

function bulletsHeight(bullets: DeckBullet[], width: number, size: number): number {
	let height = 0;
	for (const b of bullets) {
		height += estimateTextHeight(b.text, width - 0.35, size, b.sub.length ? 3 : 10);
		for (const sub of b.sub) height += estimateTextHeight(sub, width - 0.7, Math.max(12, size - 4), 6);
	}
	return height;
}

function checkBullets(bullets: DeckBullet[], width: number, height: number, size: number, where: string, out: string[]): void {
	if (bullets.length === 0) return;
	const need = bulletsHeight(bullets, width, size);
	if (need > height * OVERFLOW_TOLERANCE) {
		out.push(`${where}: the text needs about ${inches(need)} at ${size} pt but only ${inches(height)} fit. Cut the text, move detail to notes or split the slide in two.`);
	}
}

function wordCount(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
}

function checkTitle(title: string | undefined, out: string[]): void {
	if (title && title.length > 70) out.push(`the title has ${title.length} characters and will be shrunk to fit. State the point in under 70.`);
}

/** Texto da caixa cabe? Aviso com a conta; letra pequena demais também. */
function checkText(el: FreeText, label: string, out: string[]): void {
	const need = el.bullets
		? el.text.split(/\r?\n/).filter(Boolean).reduce((sum, line) => sum + estimateTextHeight(line, el.w - 0.3, el.size, 6), 0)
		: estimateTextHeight(el.text, el.w, el.size);
	if (need > el.h * OVERFLOW_TOLERANCE) {
		out.push(`${label} ${snippet(el.text)}: the text needs about ${inches(need)} at ${el.size} pt but the box is ${inches(el.h)} high. Enlarge the box, shorten the text or use a smaller size.`);
	}
}

type Rect = { x: number; y: number; w: number; h: number };
const rectOf = (el: FreeElement): Rect => ({ x: Math.min(el.x, el.x + el.w), y: Math.min(el.y, el.y + el.h), w: Math.abs(el.w), h: Math.abs(el.h) });
function overlapArea(a: Rect, b: Rect): number {
	const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
	const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
	return w > 0 && h > 0 ? w * h : 0;
}
const contains = (outer: Rect, inner: Rect) => inner.x >= outer.x - 0.02 && inner.y >= outer.y - 0.02 && inner.x + inner.w <= outer.x + outer.w + 0.02 && inner.y + inner.h <= outer.y + outer.h + 0.02;

/** Cor opaca (≥ 60%) sob o centro de `box`, vinda de uma forma anterior; senão o fundo do slide. */
function backgroundUnder(index: number, elements: readonly FreeElement[], p: DeckPalette, slideBg: string | undefined): string | undefined {
	const box = rectOf(elements[index]!);
	const cx = box.x + box.w / 2;
	const cy = box.y + box.h / 2;
	for (let i = index - 1; i >= 0; i--) {
		const el = elements[i]!;
		if (el.type !== "shape" || !el.fill || (el.opacity ?? 1) < 0.6 || el.shape === "line" || el.shape === "arrow") continue;
		const r = rectOf(el);
		if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) return resolveDeckColor(el.fill, p);
	}
	return slideBg;
}

function checkFree(elements: readonly FreeElement[], p: DeckPalette, slideBg: string | undefined, out: string[]): void {
	let small = 0;
	elements.forEach((el, i) => {
		const label = `element ${i + 1}`;
		if (el.type === "text") {
			checkText(el, label, out);
			if (el.size < MIN_READABLE_PT) small += 1;
			const bg = backgroundUnder(i, elements, p, slideBg);
			if (bg) {
				const ratio = contrastRatio(resolveDeckColor(el.color ?? "text", p), bg);
				if (ratio < 3) out.push(`${label} ${snippet(el.text)}: low contrast (${ratio.toFixed(1)}:1) between the text and its background. Use a lighter or darker color.`);
			}
		}
		if (el.type === "shape" && el.text) {
			const need = estimateTextHeight(el.text, el.w - 0.2, el.textSize ?? 18);
			if (need > el.h * OVERFLOW_TOLERANCE) out.push(`${label} (shape) ${snippet(el.text)}: the label needs about ${inches(need)} but the shape is ${inches(el.h)} high.`);
		}
	});
	if (small > 0) out.push(`${small} text box${small > 1 ? "es use" : " uses"} under ${MIN_READABLE_PT} pt, which is hard to read when presented.`);
	// Texto sobre texto/imagem/gráfico: sobreposição relevante entre dois conteúdos (formas e linhas são decoração).
	const content = elements.map((el, i) => ({ el, i })).filter(({ el }) => el.type !== "shape" && el.type !== "icon");
	for (let a = 0; a < content.length; a++) {
		for (let b = a + 1; b < content.length; b++) {
			const ra = rectOf(content[a]!.el);
			const rb = rectOf(content[b]!.el);
			const area = overlapArea(ra, rb);
			const smaller = Math.min(ra.w * ra.h, rb.w * rb.h);
			if (area > 0.2 * smaller && !contains(ra, rb) && !contains(rb, ra)) {
				out.push(`elements ${content[a]!.i + 1} and ${content[b]!.i + 1} overlap (${Math.round((area / smaller) * 100)}% of the smaller one). Move or resize one of them.`);
			} else if (area > 0 && contains(ra, rb) && content[a]!.el.type !== "text" && content[b]!.el.type === "text" && content[a]!.el.type !== "image") {
				// texto dentro de gráfico/tabela cobre os dados
				out.push(`element ${content[b]!.i + 1} sits on top of a ${content[a]!.el.type} (element ${content[a]!.i + 1}) and hides data.`);
			}
		}
	}
	const words = elements.reduce((sum, el) => sum + (el.type === "text" ? wordCount(el.text) : 0), 0);
	if (words > DENSE_WORDS) out.push(`the slide has ${words} words. Presentations read best under ${DENSE_WORDS}: split it or move detail to notes.`);
}

/** Avisos de cada slide. Funciona sem sandbox e sem imagens renderizadas. */
export function lintDeck(slides: readonly SlideInput[], options: { theme?: DeckTheme; brandColor?: string } = {}): DeckWarning[] {
	const base = buildPalette(options.theme ?? "clean", options.brandColor);
	const warnings: DeckWarning[] = [];
	slides.forEach((slide, index) => {
		const out: string[] = [];
		const { palette, backdrop } = slideStyle(base, slide);
		const bg = backdrop?.hex ?? (slide.layout === "title" || slide.layout === "section" || slide.layout === "closing" ? palette.coverBg : palette.bg);
		const bodyH = BODY_BOTTOM_IN - BODY_TOP_IN;
		switch (slide.layout) {
			case "title":
			case "section":
				checkTitle(slide.title, out);
				break;
			case "bullets":
				checkTitle(slide.title, out);
				checkBullets(slide.bullets, CONTENT_W, bodyH, bodyFontSize(slide.bullets), "bullets", out);
				break;
			case "two_column": {
				checkTitle(slide.title, out);
				const w = (CONTENT_W - 0.4) / 2 - 0.6;
				slide.columns.forEach((col, i) => checkBullets(col.bullets, w, bodyH - 1.6, Math.min(22, bodyFontSize(col.bullets, w)), `column ${i + 1}`, out));
				break;
			}
			case "image":
				checkTitle(slide.title, out);
				checkBullets(slide.bullets, 4.5, bodyH, Math.min(24, bodyFontSize(slide.bullets, 4.5)), "bullets next to the image", out);
				break;
			case "closing":
				checkTitle(slide.title, out);
				break;
			case "agenda":
				checkTitle(slide.title, out);
				slide.items.forEach((item, i) => item.length > 60 && out.push(`agenda item ${i + 1} has ${item.length} characters and will be shrunk. Keep it under 60.`));
				break;
			case "table": {
				checkTitle(slide.title, out);
				const colW = CONTENT_W / slide.columns.length;
				const size = slide.rows.length > 9 ? 13 : slide.rows.length > 6 ? 16 : 20;
				const rowH = Math.min(0.72, (6.2 - BODY_TOP_IN) / (slide.rows.length + 1));
				const longest = slide.rows.map((row) => Math.max(...row.map((cell, c) => estimateTextHeight(cell, colW - 0.3, Math.min(size, Math.max(9, Math.floor(rowH * 72 * 0.6)))))));
				const total = longest.reduce((a, b) => a + Math.max(b, rowH), 0) + rowH;
				if (total > (6.35 - BODY_TOP_IN) * OVERFLOW_TOLERANCE) out.push(`the table needs about ${inches(total)} once long cells wrap but ${inches(6.35 - BODY_TOP_IN)} fit. Shorten the cells, drop a column or split the rows across two slides.`);
				break;
			}
			case "stats":
				checkTitle(slide.title, out);
				slide.stats.forEach((s, i) => {
					if (s.value.length > 12) out.push(`KPI ${i + 1} value ${snippet(s.value)} is long and will be shrunk; use a short figure such as "R$ 164 mil".`);
					if (s.label.length > 50) out.push(`KPI ${i + 1} label has ${s.label.length} characters; keep it under 50.`);
				});
				break;
			case "timeline":
				checkTitle(slide.title, out);
				slide.steps.forEach((s, i) => s.text && s.text.length > (slide.steps.length > 4 ? 80 : 120) && out.push(`timeline step ${i + 1} text has ${s.text.length} characters and will be cramped; shorten it.`));
				break;
			case "quote":
				if (slide.quote.length > 300) out.push(`the quote has ${slide.quote.length} characters and will be shrunk. Keep it under 300.`);
				break;
			case "chart":
				checkTitle(slide.title, out);
				if (slide.chart.data.length > 12 && slide.chart.type !== "line" && slide.chart.type !== "area") out.push(`the chart has ${slide.chart.data.length} categories; labels get crowded. Aggregate to 12 or fewer.`);
				break;
			case "free":
				checkFree(slide.elements, palette, bg, out);
				break;
		}
		if (slide.background?.kind === "image") {
			const scrim = slide.background.scrim;
			if (scrim === false) out.push("photo background without a scrim: text over a busy photo may be unreadable. Keep the default scrim or set one.");
			else if (scrim && scrim.opacity < 0.3) out.push(`the photo scrim is only ${Math.round(scrim.opacity * 100)}% opaque; text may be hard to read. Use at least 35%.`);
		}
		for (const message of out) warnings.push({ slide: index + 1, message });
	});
	return warnings;
}

/** Texto do resultado da tool: até `max` avisos, o resto resumido. */
export function formatDeckWarnings(warnings: readonly DeckWarning[], max = 12): string {
	if (warnings.length === 0) return "";
	const shown = warnings.slice(0, max).map((w) => `- slide ${w.slide}: ${w.message}`);
	const rest = warnings.length - shown.length;
	return `Layout check found ${warnings.length} issue${warnings.length > 1 ? "s" : ""} (estimated from text length, not rendered):\n${shown.join("\n")}${rest > 0 ? `\n- ...and ${rest} more.` : ""}\nFix them by calling create_file again with the same filename.`;
}
