import type { DeckBullet, FreeElement, SlideInput } from "@workspace/shared";

/**
 * Conteúdo dos layouts do deck desenhado como elementos livres dentro de uma área do slide do modelo.
 * O texto principal (título, lista) vai nos placeholders do layout do usuário; o que não tem placeholder
 * (KPIs, linha do tempo, agenda, citação, gráfico, tabela, imagem) vira elementos nativos com cores de
 * tema (accent, text, surface...), que a sandbox troca pelas cores do modelo do usuário.
 */
export type Area = { x: number; y: number; w: number; h: number };

type Semantic = Exclude<SlideInput, { layout: "free" | "title" | "section" }>;

const lines = (bullets: DeckBullet[]) => bullets.flatMap((b) => [b.text, ...b.sub.map((s) => `– ${s}`)]).join("\n");

function text(area: Area, content: string, size: number, extra: Partial<Extract<FreeElement, { type: "text" }>> = {}): FreeElement {
	return { type: "text", ...area, text: content, size: Math.round(size), align: "left", valign: "top", ...extra };
}

/** `k` = escala de fonte do modelo em relação à grade 13.333 pol. de largura. */
export function semanticElements(slide: Semantic, area: Area, k: number): FreeElement[] {
	const font = (pt: number) => Math.max(10, pt * k);
	switch (slide.layout) {
		case "agenda": {
			const rowH = Math.min(0.8 * k, area.h / slide.items.length);
			return slide.items.flatMap((item, i): FreeElement[] => {
				const y = area.y + i * rowH;
				return [
					{ type: "shape", shape: "circle", x: area.x, y: y + 0.05, w: 0.5 * k, h: 0.5 * k, fill: "accent", text: String(i + 1), textSize: Math.round(font(18)), textColor: "on_accent", textBold: true },
					text({ x: area.x + 0.8 * k, y, w: area.w - 0.8 * k, h: 0.6 * k }, item, font(24), { valign: "middle" }),
				];
			});
		}
		case "stats": {
			const n = slide.stats.length;
			const gap = 0.3 * k;
			const w = (area.w - gap * (n - 1)) / n;
			const h = Math.min(area.h, 3.4 * k);
			return slide.stats.flatMap((stat, i): FreeElement[] => {
				const x = area.x + i * (w + gap);
				const size = stat.value.length > 12 ? 26 : stat.value.length > 8 ? (n >= 3 ? 30 : 40) : n === 1 ? 72 : n >= 3 ? 48 : 60;
				const out: FreeElement[] = [
					{ type: "shape", shape: "rounded_rect", x, y: area.y, w, h, fill: "surface", stroke: "border", strokeWidth: 0.75 },
					{ type: "shape", shape: "rect", x: x + 0.25 * k, y: area.y + 0.25 * k, w: 0.55 * k, h: 0.07 * k, fill: i % 2 === 0 ? "accent" : "accent2" },
					text({ x: x + 0.25 * k, y: area.y + 0.5 * k, w: w - 0.5 * k, h: 1.2 * k }, stat.value, font(size), { bold: true, color: "accent", valign: "middle", font: "heading" }),
					text({ x: x + 0.25 * k, y: area.y + 1.8 * k, w: w - 0.5 * k, h: 0.8 * k }, stat.label, font(n >= 4 ? 16 : 20)),
				];
				if (stat.detail) out.push(text({ x: x + 0.25 * k, y: area.y + 2.6 * k, w: w - 0.5 * k, h: 0.5 * k }, stat.detail, font(16), { bold: true, color: /^\s*\+/.test(stat.detail) ? "accent" : "muted" }));
				return out;
			});
		}
		case "timeline": {
			const n = slide.steps.length;
			const w = area.w / n;
			const lineY = area.y + 1.1 * k;
			const out: FreeElement[] = [{ type: "shape", shape: "rect", x: area.x, y: lineY - 0.02, w: area.w, h: 0.04 * k, fill: "border" }];
			slide.steps.forEach((step, i) => {
				const cx = area.x + w * i + w / 2;
				out.push(
					text({ x: cx - w / 2 + 0.1, y: lineY - 0.85 * k, w: w - 0.2, h: 0.5 * k }, step.label, font(18), { bold: true, color: "accent", align: "center", valign: "bottom", font: "heading" }),
					{ type: "shape", shape: "circle", x: cx - 0.18 * k, y: lineY - 0.18 * k, w: 0.36 * k, h: 0.36 * k, fill: i % 2 === 0 ? "accent" : "accent2" },
					text({ x: cx - w / 2 + 0.1, y: lineY + 0.4 * k, w: w - 0.2, h: 0.8 * k }, step.title, font(n > 4 ? 16 : 20), { bold: true, align: "center", font: "heading" }),
				);
				if (step.text) out.push(text({ x: cx - w / 2 + 0.15, y: lineY + 1.25 * k, w: w - 0.3, h: Math.max(0.8, area.h - 2.4 * k) }, step.text, font(n > 4 ? 13 : 15), { align: "center", color: "muted" }));
			});
			return out;
		}
		case "chart":
			return [{ type: "chart", ...area, h: slide.caption ? area.h - 0.5 * k : area.h, chart: slide.chart }, ...caption(slide.caption, area, k)];
		case "table":
			return [{ type: "table", ...area, h: Math.min(area.h - (slide.caption ? 0.5 * k : 0), 0.62 * k * (slide.rows.length + 1)), columns: slide.columns, rows: slide.rows }, ...caption(slide.caption, area, k)];
		case "quote": {
			const size = slide.quote.length > 220 ? 26 : slide.quote.length > 120 ? 32 : 38;
			const out: FreeElement[] = [
				text({ x: area.x, y: area.y - 0.1 * k, w: 1.5 * k, h: 1.4 * k }, "“", font(110), { bold: true, color: "accent", font: "heading" }),
				text({ x: area.x + 0.2 * k, y: area.y + 1.0 * k, w: area.w - 0.4 * k, h: Math.max(1.5, area.h - 2.2 * k) }, slide.quote, font(size), { italic: true, font: "heading" }),
			];
			if (slide.author) out.push(text({ x: area.x + 0.2 * k, y: area.y + area.h - 0.8 * k, w: area.w - 0.4 * k, h: 0.5 * k }, slide.author, font(18), { color: "muted" }));
			return out;
		}
		case "image": {
			const hasText = slide.bullets.length > 0;
			const imageW = hasText ? area.w * 0.58 : area.w;
			const out: FreeElement[] = [{ type: "image", x: area.x, y: area.y, w: imageW, h: area.h - (slide.caption ? 0.5 * k : 0), image: slide.image, fit: "contain" }];
			if (hasText) out.push(text({ x: area.x + imageW + 0.4 * k, y: area.y, w: area.w - imageW - 0.4 * k, h: area.h }, lines(slide.bullets), font(20), { bullets: true }));
			return [...out, ...caption(slide.caption, area, k)];
		}
		case "two_column": {
			const gap = 0.4 * k;
			const w = (area.w - gap) / 2;
			return slide.columns.flatMap((col, i): FreeElement[] => {
				const x = area.x + i * (w + gap);
				const out: FreeElement[] = [{ type: "shape", shape: "rounded_rect", x, y: area.y, w, h: area.h, fill: "surface", stroke: "border", strokeWidth: 0.75 }];
				let top = area.y + 0.3 * k;
				if (col.heading) {
					out.push(text({ x: x + 0.3 * k, y: top, w: w - 0.6 * k, h: 0.6 * k }, col.heading, font(22), { bold: true, valign: "middle", font: "heading" }));
					top += 0.8 * k;
				}
				if (col.bullets.length) out.push(text({ x: x + 0.3 * k, y: top, w: w - 0.6 * k, h: area.y + area.h - top - 0.25 * k }, lines(col.bullets), font(18), { bullets: true }));
				return out;
			});
		}
		case "bullets":
		case "closing":
			return slide.bullets.length ? [text(area, lines(slide.bullets), font(22), { bullets: true })] : [];
	}
}

function caption(value: string | undefined, area: Area, k: number): FreeElement[] {
	return value ? [text({ x: area.x, y: area.y + area.h - 0.45 * k, w: area.w, h: 0.45 * k }, value, Math.max(10, 13 * k), { italic: true, color: "muted" })] : [];
}

/** Escala de uma caixa/fonte da grade 13.333 x 7.5 para o tamanho do modelo. */
export function scaleFreeElement(el: FreeElement, sx: number, sy: number): FreeElement {
	const k = Math.min(sx, sy);
	const box = { x: el.x * sx, y: el.y * sy, w: el.w * sx, h: el.h * sy };
	if (el.type === "text") return { ...el, ...box, size: Math.max(8, Math.round(el.size * k)) };
	if (el.type === "shape") return { ...el, ...box, ...(el.textSize ? { textSize: Math.max(8, Math.round(el.textSize * k)) } : {}) };
	return { ...el, ...box };
}
