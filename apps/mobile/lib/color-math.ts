// Contas de cor em hex sRGB (porta de `packages/ui/src/charts/chart-palettes.ts` e do `color-mix` do web). O React Native não lê
// `color-mix` nem oklch, então misturas e contraste são calculados aqui, sempre devolvendo `#rrggbb` ou `#rrggbbaa`.

type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
	const value = Number.parseInt(hex.replace("#", "").slice(0, 6), 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
	return `#${[r, g, b].map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0")).join("")}`;
}

/** Cor com transparência: acrescenta o canal alfa (0 a 1) a uma cor em hex de 6 dígitos. */
export function hexAlpha(hex: string, alpha: number): string {
	return `${hex.slice(0, 7)}${Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, "0")}`;
}

/** Mistura `weight` (0 a 1) de `a` com o resto de `b`: o equivalente de `color-mix(in srgb, a W%, b)`. */
export function mixHex(a: string, b: string, weight: number): string {
	const [ar, ag, ab] = hexToRgb(a);
	const [br, bg, bb] = hexToRgb(b);
	return rgbToHex([ar * weight + br * (1 - weight), ag * weight + bg * (1 - weight), ab * weight + bb * (1 - weight)]);
}

export function relativeLuminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex).map((channel) => {
		const c = channel / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	}) as Rgb;
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l = (max + min) / 2;
	if (max === min) return [0, 0, l];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h: number;
	if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
	else if (max === gn) h = (bn - rn) / d + 2;
	else h = (rn - gn) / d + 4;
	return [h * 60, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): Rgb {
	const k = (n: number) => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Contraste mínimo de elemento gráfico contra o fundo (WCAG 1.4.11). */
export const MIN_GRAPHIC_CONTRAST = 3;

/**
 * Ajusta só a luminosidade (matiz e saturação ficam) até a cor passar do contraste mínimo contra o fundo: escurece no
 * claro, clareia no escuro. Cor que já passa não muda. Mesmo algoritmo do `ensureContrast` do web.
 */
export function ensureContrast(hex: string, surface: string, min = MIN_GRAPHIC_CONTRAST): string {
	if (contrastRatio(hex, surface) >= min) return hex;
	const [h, s, l] = rgbToHsl(hexToRgb(hex));
	const surfaceIsLight = relativeLuminance(surface) > 0.5;
	const step = surfaceIsLight ? -0.01 : 0.01;
	let next = l;
	for (let i = 0; i < 100; i += 1) {
		next = Math.min(1, Math.max(0, next + step));
		const candidate = rgbToHex(hslToRgb([h, s, next]));
		if (contrastRatio(candidate, surface) >= min) return candidate;
		if (next <= 0 || next >= 1) break;
	}
	return rgbToHex(hslToRgb([h, s, surfaceIsLight ? 0 : 1]));
}
