/**
 * Apresentações: layout livre (`free`), fundos (`background`) e cores por token.
 * Só funções puras; o desenho (pptxgenjs/python-pptx) mora em `packages/agent-runtime`.
 *
 * Grade do layout livre: 16:9 em polegadas, 13.333 x 7.5, origem no canto superior esquerdo.
 */
import { normalizeChartHexColor, type ChartSpec } from "./chart-spec.js";
import { fail, list, need, obj, parseChart, parseDeckImageId, str } from "./deck-util.js";

export const DECK_PAGE_W = 13.333;
export const DECK_PAGE_H = 7.5;
export const DECK_FREE_MAX_ELEMENTS = 30;
export const DECK_FREE_TEXT_MAX_CHARS = 1_200;
export const DECK_FREE_TABLE_MAX_ROWS = 12;
export const DECK_FREE_TABLE_MAX_COLUMNS = 8;
/** Folga ao conferir limites da página (arredondamento do modelo). */
const BOUNDS_TOLERANCE = 0.02;

/** Cores do tema: o desenho troca pelo valor do tema (ou do template do usuário). */
export const DECK_COLOR_TOKENS = ["accent", "accent2", "text", "muted", "surface", "bg", "border", "on_accent"] as const;
export type DeckColorToken = (typeof DECK_COLOR_TOKENS)[number];

/** `#rrggbb` (minúsculo) ou um token do tema. */
export type DeckColor = string;

/** Ícones disponíveis (lucide, ISC). Os desenhos estão em `agent-runtime/src/files/deck/icon-data.ts`. */
export const DECK_ICON_NAMES = [
	"rocket", "target", "users", "user", "chart-line", "chart-column", "chart-pie", "trending-up", "trending-down",
	"dollar-sign", "wallet", "credit-card", "shopping-cart", "store", "package", "truck", "globe", "map-pin", "building-2",
	"house", "factory", "wheat", "leaf", "sprout", "tractor", "sun", "droplets", "zap", "battery", "lightbulb", "cpu", "code",
	"database", "cloud", "shield-check", "lock", "key", "settings", "wrench", "hammer", "clock", "calendar", "check",
	"circle-check", "x", "triangle-alert", "info", "star", "heart", "thumbs-up", "award", "trophy", "flag", "handshake",
	"megaphone", "mail", "phone", "message-circle", "link", "search", "eye", "graduation-cap", "book-open", "file-text",
	"camera", "image", "play", "smartphone", "laptop", "wifi", "scale", "percent", "arrow-right", "repeat", "layers",
	"puzzle", "sparkles", "brain", "banknote", "receipt", "clipboard-list", "briefcase", "coins",
] as const;
export type DeckIconName = (typeof DECK_ICON_NAMES)[number];

export const DECK_SHAPES = ["rect", "rounded_rect", "circle", "line", "arrow"] as const;
export type DeckShapeKind = (typeof DECK_SHAPES)[number];

type Box = { x: number; y: number; w: number; h: number };

export type FreeText = Box & {
	type: "text";
	text: string;
	size: number;
	bold?: boolean;
	italic?: boolean;
	color?: DeckColor;
	align: "left" | "center" | "right";
	valign: "top" | "middle" | "bottom";
	font?: "heading" | "body";
	/** Cada linha do texto vira um item de lista. */
	bullets?: boolean;
};
export type FreeShape = Box & {
	type: "shape";
	shape: DeckShapeKind;
	fill?: DeckColor;
	stroke?: DeckColor;
	strokeWidth?: number;
	/** 0 (transparente) a 1 (sólido). */
	opacity?: number;
	/** Texto dentro da forma (não vale para linha/seta). */
	text?: string;
	textSize?: number;
	textColor?: DeckColor;
	textBold?: boolean;
};
export type FreeImage = Box & { type: "image"; image: string; fit: "contain" | "cover" };
export type FreeIcon = Box & { type: "icon"; name: DeckIconName; color?: DeckColor };
export type FreeChart = Box & { type: "chart"; chart: ChartSpec };
export type FreeTable = Box & { type: "table"; columns: string[]; rows: string[][] };
export type FreeElement = FreeText | FreeShape | FreeImage | FreeIcon | FreeChart | FreeTable;

export type DeckScrim = { color: DeckColor; opacity: number };
export type DeckBackground =
	| { kind: "color"; color: DeckColor }
	| { kind: "gradient"; from: DeckColor; to: DeckColor; angle: number }
	| { kind: "image"; image: string; scrim?: DeckScrim | false };

export function isDeckColorToken(value: string): value is DeckColorToken {
	return (DECK_COLOR_TOKENS as readonly string[]).includes(value);
}

/** Aceita `#rgb`, `#rrggbb` ou um token do tema; devolve `#rrggbb` minúsculo ou o token. */
export function parseDeckColor(value: unknown, label: string): DeckColor {
	if (typeof value === "string") {
		const trimmed = value.trim().toLowerCase();
		if (isDeckColorToken(trimmed)) return trimmed;
		const hex = normalizeChartHexColor(trimmed);
		if (hex) return hex;
	}
	return fail(`${label} must be a hex color like "#1d6b3a" or a theme token (${DECK_COLOR_TOKENS.join(", ")}).`);
}

function optColor(value: unknown, label: string): DeckColor | undefined {
	return value === undefined || value === null || value === "" ? undefined : parseDeckColor(value, label);
}

function num(value: unknown, label: string, min: number, max: number): number {
	const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n)) return fail(`${label} must be a number.`);
	if (n < min || n > max) return fail(`${label} must be between ${min} and ${max} (got ${n}).`);
	return Math.round(n * 1000) / 1000;
}

function optNum(value: unknown, label: string, min: number, max: number): number | undefined {
	return value === undefined || value === null || value === "" ? undefined : num(value, label, min, max);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string, fallback?: T): T {
	if (value === undefined || value === null || value === "") {
		if (fallback) return fallback;
		return fail(`${label} is required (${allowed.join(", ")}).`);
	}
	const text = typeof value === "string" ? value.trim().toLowerCase() : "";
	if ((allowed as readonly string[]).includes(text)) return text as T;
	return fail(`${label} must be one of: ${allowed.join(", ")}.`);
}

/** Retângulo dentro da página 13.333 x 7.5. Linhas e setas aceitam w/h negativos (vetor). */
function parseBox(e: Record<string, unknown>, label: string, vector: boolean): Box {
	const x = num(e.x, `${label}.x`, 0, DECK_PAGE_W);
	const y = num(e.y, `${label}.y`, 0, DECK_PAGE_H);
	const w = num(e.w, `${label}.w`, vector ? -DECK_PAGE_W : 0, DECK_PAGE_W);
	const h = num(e.h, `${label}.h`, vector ? -DECK_PAGE_H : 0, DECK_PAGE_H);
	if (!vector && (w <= 0 || h <= 0)) fail(`${label} needs w and h greater than 0.`);
	const right = Math.max(x, x + w);
	const bottom = Math.max(y, y + h);
	const left = Math.min(x, x + w);
	const top = Math.min(y, y + h);
	if (right > DECK_PAGE_W + BOUNDS_TOLERANCE || bottom > DECK_PAGE_H + BOUNDS_TOLERANCE || left < -BOUNDS_TOLERANCE || top < -BOUNDS_TOLERANCE) {
		fail(`${label} falls outside the ${DECK_PAGE_W} x ${DECK_PAGE_H} in slide (x=${x}, y=${y}, w=${w}, h=${h}). Keep x+w <= ${DECK_PAGE_W} and y+h <= ${DECK_PAGE_H}.`);
	}
	return { x, y, w, h };
}

function parseElement(raw: unknown, label: string): FreeElement {
	const e = obj(raw, label);
	const type = oneOf(e.type, ["text", "shape", "image", "icon", "chart", "table"] as const, `${label}.type`);
	switch (type) {
		case "text": {
			const box = parseBox(e, label, false);
			const color = optColor(e.color, `${label}.color`);
			const font = e.font === undefined || e.font === null ? undefined : oneOf(e.font, ["heading", "body"] as const, `${label}.font`);
			return {
				type: "text",
				...box,
				text: need(e.text, DECK_FREE_TEXT_MAX_CHARS, `${label}.text`),
				size: num(e.size ?? 18, `${label}.size`, 8, 120),
				...(e.bold === true ? { bold: true } : {}),
				...(e.italic === true ? { italic: true } : {}),
				...(color ? { color } : {}),
				align: oneOf(e.align, ["left", "center", "right"] as const, `${label}.align`, "left"),
				valign: oneOf(e.valign, ["top", "middle", "bottom"] as const, `${label}.valign`, "top"),
				...(font ? { font } : {}),
				...(e.bullets === true ? { bullets: true } : {}),
			};
		}
		case "shape": {
			const shape = oneOf(e.shape, DECK_SHAPES, `${label}.shape`, "rect");
			const isLine = shape === "line" || shape === "arrow";
			const box = parseBox(e, label, isLine);
			const fill = optColor(e.fill, `${label}.fill`);
			const stroke = optColor(e.stroke, `${label}.stroke`);
			const strokeWidth = optNum(e.stroke_width ?? e.strokeWidth, `${label}.stroke_width`, 0, 20);
			const opacity = optNum(e.opacity, `${label}.opacity`, 0, 1);
			const text = isLine ? undefined : str(e.text, 300, `${label}.text`);
			const textColor = optColor(e.text_color ?? e.textColor, `${label}.text_color`);
			const textSize = optNum(e.text_size ?? e.textSize, `${label}.text_size`, 8, 120);
			if (isLine && !stroke && !fill) fail(`${label} (${shape}) needs a stroke color.`);
			return {
				type: "shape",
				shape,
				...box,
				// Linha sem fill: o traço é a cor. Forma sem nada: preenche com o destaque do tema.
				...(fill ? { fill } : {}),
				...(stroke || isLine ? { stroke: stroke ?? fill! } : {}),
				...(strokeWidth !== undefined ? { strokeWidth } : {}),
				...(opacity !== undefined ? { opacity } : {}),
				...(text ? { text } : {}),
				...(textSize !== undefined ? { textSize } : {}),
				...(textColor ? { textColor } : {}),
				...((e.text_bold ?? e.textBold) === true ? { textBold: true } : {}),
			};
		}
		case "image": {
			const box = parseBox(e, label, false);
			return { type: "image", ...box, image: parseDeckImageId(e.image, `${label}.image`), fit: oneOf(e.fit, ["contain", "cover"] as const, `${label}.fit`, "contain") };
		}
		case "icon": {
			const box = parseBox(e, label, false);
			const color = optColor(e.color, `${label}.color`);
			const name = typeof e.name === "string" ? e.name.trim().toLowerCase() : "";
			if (!(DECK_ICON_NAMES as readonly string[]).includes(name)) {
				fail(`${label}.name "${String(e.name)}" is not an available icon. Use one of: ${DECK_ICON_NAMES.join(", ")}.`);
			}
			return { type: "icon", ...box, name: name as DeckIconName, ...(color ? { color } : {}) };
		}
		case "chart": {
			const box = parseBox(e, label, false);
			return { type: "chart", ...box, chart: parseChart(e.chart, `${label}.chart`) };
		}
		case "table": {
			const box = parseBox(e, label, false);
			const columns = list(e.columns, `${label}.columns`, 1, DECK_FREE_TABLE_MAX_COLUMNS).map((c) => String(c ?? "").trim().slice(0, 80));
			const rows = list(e.rows, `${label}.rows`, 1, DECK_FREE_TABLE_MAX_ROWS).map((row, r) => {
				if (!Array.isArray(row)) fail(`${label}.rows[${r}] must be an array of cells.`);
				if (row.length > columns.length) fail(`${label}.rows[${r}] has more cells than columns (${columns.length}).`);
				return columns.map((_, c) => String(row[c] ?? "").trim().slice(0, 200));
			});
			return { type: "table", ...box, columns, rows };
		}
	}
}

/** `elements` do layout `free`: 1 a 30 elementos, todos dentro da página. */
export function parseFreeElements(value: unknown, label: string): FreeElement[] {
	const items = list(value, label, 1, DECK_FREE_MAX_ELEMENTS);
	return items.map((raw, i) => parseElement(raw, `${label}[${i}]`));
}

/**
 * `background` de qualquer slide: `{color}`, `{gradient:{from,to,angle?}}` ou `{image, scrim?}`.
 * A imagem é um id (anexo ou `generate_image`), nunca URL. `scrim:false` desliga o véu de legibilidade.
 */
export function parseDeckBackground(value: unknown, label: string): DeckBackground | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value === "string") return { kind: "color", color: parseDeckColor(value, label) };
	const b = obj(value, label);
	const keys = ["color", "gradient", "image"].filter((k) => b[k] !== undefined && b[k] !== null && b[k] !== "");
	if (keys.length !== 1) fail(`${label} needs exactly one of: color, gradient, image.`);
	if (keys[0] === "color") return { kind: "color", color: parseDeckColor(b.color, `${label}.color`) };
	if (keys[0] === "gradient") {
		const g = obj(b.gradient, `${label}.gradient`);
		return { kind: "gradient", from: parseDeckColor(g.from, `${label}.gradient.from`), to: parseDeckColor(g.to, `${label}.gradient.to`), angle: optNum(g.angle, `${label}.gradient.angle`, 0, 360) ?? 135 };
	}
	const image = parseDeckImageId(b.image, `${label}.image`);
	if (b.scrim === false) return { kind: "image", image, scrim: false };
	if (b.scrim === undefined || b.scrim === null || b.scrim === true) return { kind: "image", image };
	const s = obj(b.scrim, `${label}.scrim`);
	return { kind: "image", image, scrim: { color: parseDeckColor(s.color ?? "#000000", `${label}.scrim.color`), opacity: num(s.opacity ?? 0.45, `${label}.scrim.opacity`, 0, 0.95) } };
}

/** Ids de imagem de um elemento livre ou de um fundo. */
export function freeImageIds(elements: readonly FreeElement[]): string[] {
	return elements.flatMap((e) => (e.type === "image" ? [e.image] : []));
}
