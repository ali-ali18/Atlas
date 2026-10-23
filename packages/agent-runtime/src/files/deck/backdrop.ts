import type { DeckBackground, SlideInput } from "@workspace/shared";
import { mixColors, readableOn, stripHash, type DeckPalette } from "./themes.js";

/**
 * Fundo de um slide e como o resto do slide se adapta a ele: cor do texto legível
 * (paleta invertida quando o fundo contraria o tema) e véu sobre fotos.
 * Funções puras: o desenho e as imagens ficam em `layouts.ts`/`assets.ts`.
 */

/** Cor de um elemento/fundo do deck: `#rrggbb` ou token do tema → hex sem "#", maiúsculo. */
export function resolveDeckColor(color: string, p: DeckPalette): string {
	switch (color) {
		case "accent":
			return p.accent;
		case "accent2":
			return p.accent2;
		case "text":
			return p.text;
		case "muted":
			return p.muted;
		case "surface":
			return p.surface;
		case "bg":
			return p.bg;
		case "border":
			return p.border;
		case "on_accent":
			return p.onAccent;
		default:
			return stripHash(color);
	}
}

/** O hex (sem "#") pede texto claro por cima? */
export function isDarkColor(hex: string): boolean {
	return readableOn(hex) === "FFFFFF";
}

export type Scrim = { color: string; opacity: number };

export type Backdrop = {
	/** Cor de referência do fundo (gradiente = ponto médio). Ausente em foto. */
	hex?: string;
	/** O fundo, já com o véu, pede texto claro. */
	dark: boolean;
	scrim?: Scrim;
};

const COVER_SCRIM: Scrim = { color: "000000", opacity: 0.45 };
const CONTENT_SCRIM: Scrim = { color: "FFFFFF", opacity: 0.82 };

/** Véu padrão de uma foto de fundo: escuro nas capas (texto branco), claro no conteúdo (texto escuro). */
export function defaultScrim(cover: boolean): Scrim {
	return cover ? COVER_SCRIM : CONTENT_SCRIM;
}

export function resolveBackdrop(bg: DeckBackground | undefined, cover: boolean, p: DeckPalette): Backdrop | undefined {
	if (!bg) return undefined;
	if (bg.kind === "color") {
		const hex = resolveDeckColor(bg.color, p);
		return { hex, dark: isDarkColor(hex) };
	}
	if (bg.kind === "gradient") {
		const from = resolveDeckColor(bg.from, p);
		const to = resolveDeckColor(bg.to, p);
		const hex = mixColors(from, to, 0.5);
		return { hex, dark: isDarkColor(hex) };
	}
	if (bg.scrim === false) return { dark: cover };
	const raw = bg.scrim ?? defaultScrim(cover);
	const scrim: Scrim = { color: resolveDeckColor(raw.color, p), opacity: raw.opacity };
	// Foto sem véu forte: o texto continua no estilo do tipo de slide (branco nas capas).
	const strong = scrim.opacity >= 0.35;
	return { dark: strong ? isDarkColor(scrim.color) : cover, scrim };
}

/**
 * Paleta do slide sobre o fundo escolhido. Capas usam texto claro por padrão; fundo claro troca para
 * texto escuro. Conteúdo troca as cores de texto/superfície quando o fundo contraria o tema.
 */
export function adaptPalette(p: DeckPalette, cover: boolean, backdrop: Backdrop | undefined): DeckPalette {
	if (!backdrop) return p;
	if (cover) {
		if (backdrop.dark) return p;
		return { ...p, coverText: "111827", coverMuted: "475467", coverAccent: p.accent };
	}
	const themeDark = isDarkColor(p.bg);
	if (themeDark === backdrop.dark) return p;
	const base = backdrop.hex ?? (backdrop.dark ? "0F172A" : "FFFFFF");
	const ink = backdrop.dark ? "F8FAFC" : "111827";
	return {
		...p,
		bg: base,
		text: ink,
		muted: mixColors(ink, base, 0.3),
		surface: mixColors(base, ink, 0.08),
		border: mixColors(base, ink, 0.22),
	};
}

const COVER_LAYOUTS: ReadonlySet<string> = new Set(["title", "section", "closing"]);

/** Paleta e fundo efetivos de um slide (a paleta já adaptada ao fundo escolhido). */
export function slideStyle(base: DeckPalette, slide: SlideInput): { palette: DeckPalette; backdrop: Backdrop | undefined } {
	const cover = COVER_LAYOUTS.has(slide.layout);
	const backdrop = resolveBackdrop(slide.background, cover, base);
	return { palette: adaptPalette(base, cover, backdrop), backdrop };
}
