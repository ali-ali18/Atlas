import type { DeckTheme } from "@workspace/shared";

/** Cores em hex sem "#" (formato do pptxgenjs). */
export type DeckPalette = {
	bg: string;
	surface: string;
	border: string;
	text: string;
	muted: string;
	accent: string;
	accent2: string;
	/** Destaque sobre o fundo da capa/seção (legível no `coverBg`). */
	coverAccent: string;
	/** Texto sobre o `accent`. */
	onAccent: string;
	coverBg: string;
	coverText: string;
	coverMuted: string;
	headFont: string;
	bodyFont: string;
	/** Cores de séries/fatias nos gráficos, em ordem. */
	series: string[];
	positive: string;
	negative: string;
};

const BASE = {
	clean: { bg: "FFFFFF", surface: "F3F5F9", border: "DDE3EC", text: "1F2933", muted: "667085", accent: "2563EB", accent2: "0EA5A4", coverBg: "0F172A", headFont: "Calibri", bodyFont: "Calibri" },
	dark: { bg: "0F172A", surface: "1E293B", border: "334155", text: "F1F5F9", muted: "94A3B8", accent: "38BDF8", accent2: "A78BFA", coverBg: "020617", headFont: "Calibri", bodyFont: "Calibri" },
	corporate: { bg: "FFFFFF", surface: "F4F1EA", border: "D9D3C5", text: "1B2A41", muted: "5F6B7A", accent: "1F4E79", accent2: "B8902A", coverBg: "1B2A41", headFont: "Georgia", bodyFont: "Calibri" },
	vivid: { bg: "FFFFFF", surface: "F6F1FF", border: "E2D7F7", text: "1F1B2E", muted: "6B6480", accent: "7C3AED", accent2: "F97316", coverBg: "4C1D95", headFont: "Calibri", bodyFont: "Calibri" },
} satisfies Record<DeckTheme, Partial<DeckPalette>>;

function rgb(hex: string): [number, number, number] {
	return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function toHex([r, g, b]: [number, number, number]): string {
	return [r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** Mistura `hex` com `other` (0 = hex, 1 = other). */
export function mixColors(hex: string, other: string, amount: number): string {
	const a = rgb(hex);
	const b = rgb(other);
	return toHex([a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount]);
}

function luminance(hex: string): number {
	const [r, g, b] = rgb(hex).map((v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Razão de contraste WCAG entre duas cores (hex sem "#"): 1 a 21. */
export function contrastRatio(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi! + 0.05) / (lo! + 0.05);
}

/** Preto ou branco, o que contrasta mais com `bg`. */
export function readableOn(bg: string): string {
	return luminance(bg) > 0.4 ? "111827" : "FFFFFF";
}

/** `#aabbcc` → `AABBCC`. */
export function stripHash(color: string): string {
	return color.replace(/^#/, "").toUpperCase();
}

/** Paleta do tema; a cor da marca (hex) troca o destaque principal e, nos temas com capa colorida, a capa. */
export function buildPalette(theme: DeckTheme, brandColor?: string): DeckPalette {
	const base = BASE[theme];
	const accent = brandColor ? stripHash(brandColor) : base.accent;
	const accent2 = brandColor ? mixColors(accent, theme === "dark" ? "FFFFFF" : "000000", theme === "dark" ? 0.45 : 0.35) : base.accent2;
	const coverBg = brandColor && (theme === "vivid" || theme === "corporate") ? mixColors(accent, "000000", 0.45) : base.coverBg;
	const series = [accent, accent2, mixColors(accent, "FFFFFF", 0.3), mixColors(accent2, "000000", 0.3), mixColors(accent, "000000", 0.4), mixColors(accent2, "FFFFFF", 0.5)];
	const lightSurface = theme !== "dark";
	return {
		...base,
		...(brandColor && lightSurface ? { surface: mixColors("FFFFFF", accent, 0.07), border: mixColors("FFFFFF", accent, 0.2) } : {}),
		accent,
		accent2,
		coverAccent: brandColor ? mixColors(accent, "FFFFFF", 0.45) : accent2,
		coverBg,
		onAccent: readableOn(accent),
		coverText: "FFFFFF",
		coverMuted: mixColors(readableOn(coverBg) === "FFFFFF" ? "FFFFFF" : "111827", coverBg, 0.3),
		series,
		positive: theme === "dark" ? "4ADE80" : "15803D",
		negative: theme === "dark" ? "F87171" : "B91C1C",
	};
}
