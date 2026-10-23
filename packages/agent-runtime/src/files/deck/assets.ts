import sharp from "sharp";
import type { DeckBackground, SlideInput } from "@workspace/shared";
import { resolveDeckColor, slideStyle } from "./backdrop.js";
import type { DeckImage } from "./images.js";
import { ICON_NODES } from "./icon-data.js";
import type { DeckPalette } from "./themes.js";

/**
 * Imagens derivadas que o pptxgenjs não gera sozinho: ícones (SVG → PNG), gradientes de fundo,
 * fotos de fundo recortadas em 16:9 e imagens `cover` recortadas à caixa. Tudo sai como
 * `image/…;base64,…` pronto para `addImage`/`background`. Chaves estáveis: o desenho só consulta.
 */
export type DeckAssets = Map<string, string>;

const BG_W = 1920;
const BG_H = 1080;
const ICON_PX = 256;

export const iconKey = (name: string, hex: string) => `icon:${name}:${hex}`;
export const gradientKey = (index: number) => `gradient:${index}`;
export const backgroundKey = (index: number) => `background:${index}`;
export const coverKey = (id: string, w: number, h: number) => `cover:${id}:${w.toFixed(2)}x${h.toFixed(2)}`;

/** SVG de um ícone lucide (traço de 2 em grade 24). */
export function iconSvg(name: string, hex: string): string | undefined {
	const nodes = ICON_NODES[name];
	if (!nodes) return undefined;
	const body = nodes
		.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${String(v).replace(/"/g, "&quot;")}"`).join(" ")}/>`)
		.join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#${hex}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

/** Ponta inicial e final da linha do gradiente em coordenadas 0-1 (ângulo CSS: 0 = de baixo para cima, 90 = para a direita). */
export function gradientVector(angle: number): { x1: number; y1: number; x2: number; y2: number } {
	const rad = (angle * Math.PI) / 180;
	const dx = Math.sin(rad) / 2;
	const dy = -Math.cos(rad) / 2;
	return { x1: 0.5 - dx, y1: 0.5 - dy, x2: 0.5 + dx, y2: 0.5 + dy };
}

export function gradientSvg(from: string, to: string, angle: number): string {
	const v = gradientVector(angle);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${BG_W}" height="${BG_H}"><defs><linearGradient id="g" x1="${v.x1}" y1="${v.y1}" x2="${v.x2}" y2="${v.y2}"><stop offset="0" stop-color="#${from}"/><stop offset="1" stop-color="#${to}"/></linearGradient></defs><rect width="${BG_W}" height="${BG_H}" fill="url(#g)"/></svg>`;
}

const asData = (mime: string, bytes: Buffer) => `${mime};base64,${bytes.toString("base64")}`;
const fromData = (image: DeckImage) => Buffer.from(image.data.slice(image.data.indexOf(",") + 1), "base64");

/** Recorta a imagem para preencher a proporção w:h (como `object-fit: cover`). */
async function coverCrop(image: DeckImage, width: number, height: number, mime: "jpeg" | "png"): Promise<string> {
	const pipeline = sharp(fromData(image)).resize({ width, height, fit: "cover", position: "centre" });
	const out = await (mime === "png" ? pipeline.png() : pipeline.jpeg({ quality: 88, mozjpeg: true })).toBuffer();
	return asData(`image/${mime}`, out);
}

function backgroundImageId(bg: DeckBackground | undefined): string | undefined {
	return bg?.kind === "image" ? bg.image : undefined;
}

/** Gera, uma vez, tudo o que os slides precisam além das imagens já resolvidas. */
export async function prepareDeckAssets(slides: readonly SlideInput[], base: DeckPalette, images: ReadonlyMap<string, DeckImage>): Promise<DeckAssets> {
	const assets: DeckAssets = new Map();
	for (const [index, slide] of slides.entries()) {
		const { palette } = slideStyle(base, slide);
		const bg = slide.background;
		if (bg?.kind === "gradient") {
			const svg = gradientSvg(resolveDeckColor(bg.from, palette), resolveDeckColor(bg.to, palette), bg.angle);
			assets.set(gradientKey(index), asData("image/jpeg", await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer()));
		}
		const bgId = backgroundImageId(bg);
		if (bgId) {
			const image = images.get(bgId);
			if (!image) throw new Error(`Image ${bgId} was not resolved.`);
			assets.set(backgroundKey(index), await coverCrop(image, BG_W, BG_H, "jpeg"));
		}
		if (slide.layout !== "free") continue;
		for (const el of slide.elements) {
			if (el.type === "icon") {
				const hex = resolveDeckColor(el.color ?? "text", palette);
				const key = iconKey(el.name, hex);
				if (assets.has(key)) continue;
				const svg = iconSvg(el.name, hex);
				if (!svg) throw new Error(`Icon ${el.name} is not available.`);
				assets.set(key, asData("image/png", await sharp(Buffer.from(svg), { density: 384 }).resize(ICON_PX, ICON_PX).png().toBuffer()));
			} else if (el.type === "image" && el.fit === "cover") {
				const image = images.get(el.image);
				if (!image) throw new Error(`Image ${el.image} was not resolved.`);
				const key = coverKey(el.image, el.w, el.h);
				if (assets.has(key)) continue;
				const px = 160;
				assets.set(key, await coverCrop(image, Math.max(16, Math.round(el.w * px)), Math.max(16, Math.round(el.h * px)), "jpeg"));
			}
		}
	}
	return assets;
}
