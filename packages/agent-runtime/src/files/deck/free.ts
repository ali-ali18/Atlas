import type { FreeElement, FreeShape, FreeText, SlideInput } from "@workspace/shared";
import { coverKey, iconKey } from "./assets.js";
import { resolveDeckColor } from "./backdrop.js";
import { fitInside, placeChart, placeTable, type DeckContext, type Box } from "./layouts.js";
import type { DeckPalette } from "./themes.js";

/**
 * Layout `free`: cada elemento vira um objeto editável do PowerPoint (caixa de texto, forma, imagem,
 * gráfico ou tabela nativos) na posição pedida. Ícones entram como imagem PNG.
 */
type Slide = Parameters<typeof placeTable>[0];
type FreeSlide = Extract<SlideInput, { layout: "free" }>;

const SHAPE_TYPES = { rect: "rect", rounded_rect: "roundRect", circle: "ellipse" } as const;

const color = (value: string | undefined, fallback: string, p: DeckPalette) => resolveDeckColor(value ?? fallback, p);

function drawText(slide: Slide, el: FreeText, p: DeckPalette): void {
	const base = {
		x: el.x,
		y: el.y,
		w: el.w,
		h: el.h,
		fontSize: el.size,
		bold: el.bold === true,
		italic: el.italic === true,
		color: color(el.color, "text", p),
		align: el.align,
		valign: el.valign,
		fontFace: el.font === "heading" ? p.headFont : p.bodyFont,
		margin: 0,
		fit: "shrink" as const,
	};
	if (el.bullets) {
		const lines = el.text.split(/\r?\n/).filter((line) => line.trim());
		slide.addText(
			lines.map((line) => ({ text: line, options: { bullet: { characterCode: "25A0", indent: 20 }, breakLine: true, paraSpaceAfter: 6 } })),
			base,
		);
		return;
	}
	slide.addText(el.text, base);
}

/** Linha/seta com vetor (w, h) que pode ser negativo: vira x/y positivos + espelhamento. */
function lineGeometry(el: FreeShape): { x: number; y: number; w: number; h: number; flipH: boolean; flipV: boolean } {
	return { x: Math.min(el.x, el.x + el.w), y: Math.min(el.y, el.y + el.h), w: Math.abs(el.w), h: Math.abs(el.h), flipH: el.w < 0, flipV: el.h < 0 };
}

function drawShape(ctx: DeckContext, slide: Slide, el: FreeShape, p: DeckPalette): void {
	if (el.shape === "line" || el.shape === "arrow") {
		const g = lineGeometry(el);
		slide.addShape("line", {
			x: g.x,
			y: g.y,
			w: g.w,
			h: g.h,
			flipH: g.flipH,
			flipV: g.flipV,
			line: { color: color(el.stroke, "accent", p), width: el.strokeWidth ?? 2, ...(el.shape === "arrow" ? { endArrowType: "triangle" as const } : {}) },
		});
		return;
	}
	const type = SHAPE_TYPES[el.shape];
	const fillHex = el.fill ? resolveDeckColor(el.fill, p) : undefined;
	const transparency = el.opacity === undefined ? 0 : Math.round((1 - el.opacity) * 100);
	const strokeHex = el.stroke ? resolveDeckColor(el.stroke, p) : undefined;
	const options = {
		x: el.x,
		y: el.y,
		w: el.w,
		h: el.h,
		...(fillHex ? { fill: { color: fillHex, transparency } } : {}),
		line: strokeHex ? { color: strokeHex, width: el.strokeWidth ?? 1 } : { color: fillHex ?? p.border, width: 0, transparency: 100 },
		...(el.shape === "rounded_rect" ? { rectRadius: Math.min(0.5, Math.min(el.w, el.h) * 0.15) } : {}),
	};
	if (el.text) {
		slide.addText(el.text, {
			...options,
			shape: ctx.pptx.ShapeType[type],
			fontSize: el.textSize ?? 18,
			bold: el.textBold === true,
			color: color(el.textColor, fillHex ? "on_accent" : "text", p),
			align: "center",
			valign: "middle",
			fontFace: p.bodyFont,
			margin: 0.08,
			fit: "shrink",
		});
		return;
	}
	slide.addShape(type, options);
}

function drawElement(ctx: DeckContext, slide: Slide, el: FreeElement, p: DeckPalette): void {
	const box: Box = { x: el.x, y: el.y, w: el.w, h: el.h };
	switch (el.type) {
		case "text":
			return drawText(slide, el, p);
		case "shape":
			return drawShape(ctx, slide, el, p);
		case "image": {
			const image = ctx.images.get(el.image);
			if (!image) throw new Error(`Image ${el.image} was not resolved.`);
			if (el.fit === "cover") {
				const data = ctx.assets.get(coverKey(el.image, el.w, el.h));
				if (!data) throw new Error(`Image ${el.image} was not prepared.`);
				slide.addImage({ data, ...box });
				return;
			}
			slide.addImage({ data: image.data, ...fitInside(box, image) });
			return;
		}
		case "icon": {
			const data = ctx.assets.get(iconKey(el.name, resolveDeckColor(el.color ?? "text", p)));
			if (!data) throw new Error(`Icon ${el.name} was not prepared.`);
			slide.addImage({ data, ...fitInside(box, { width: 1, height: 1 }), altText: el.name });
			return;
		}
		case "chart":
			return placeChart(ctx.pptx, slide, el.chart, box, p);
		case "table":
			return placeTable(slide, p, el.columns, el.rows, box);
	}
}

export function drawFree(ctx: DeckContext, slide: Slide, input: FreeSlide): void {
	for (const el of input.elements) drawElement(ctx, slide, el, ctx.palette);
}
