// Renderer: Frame (dados) → SVG. Funções puras que devolvem strings; o
// componente só escreve essas strings nos atributos (e apenas quando mudam).
//
// Olhos: por padrão são RECORTADOS (cutout): o corpo leva uma `<mask>` com
// dois buracos e o olho mostra o que está atrás do avatar (fundo, item
// selecionado, tema claro ou escuro). Com cor de olho explícita, o olho é
// pintado e recortado para dentro do corpo (nunca vaza da borda).
import { hash, round2 } from "../geometry/math.js";
import { AVATAR_BOX, BODY_RADIUS_PX, CENTER } from "../geometry/shapes.js";
import { eyeColorFor } from "../identity.js";
import type { Frame } from "../model/character.js";
import { partsMarkup } from "./parts.js";
import { projectFrame } from "./project.js";

export { bodyPath, eyePath, eyePoints, eyesPath } from "./path.js";

export const AVATAR_VIEWBOX = `0 0 ${AVATAR_BOX} ${AVATAR_BOX}`;
export const DEFAULT_EYE_COLOR = "#0a0a0c";

/** Área das máscaras: folgada, porque o corpo gira e se desloca fora dos 250. */
export const MASK_BOX = { min: -60, size: 370 } as const;

/**
 * Transform do grupo do corpo: zoom do clipe (respiração), squash ancorado
 * (0 = centro, -1 = base do corpo) e deslocamento. A orientação 3D já está no
 * path (render/project); aqui só há escala e translação.
 */
export function groupTransform(frame: Frame): string {
	const sx = frame.scale * frame.scaleX;
	const sy = frame.scale * frame.scaleY;
	// Âncora do squash: -1 = um raio do corpo abaixo do centro.
	const pivot = round2(-frame.squashAnchor * BODY_RADIUS_PX * frame.fit * frame.scale);
	return (
		`translate(${round2(CENTER + frame.offsetX)} ${round2(CENTER + frame.offsetY + pivot)})` +
		` scale(${Math.round(sx * 10000) / 10000} ${Math.round(sy * 10000) / 10000})` +
		` translate(${-CENTER} ${-(CENTER + pivot)})`
	);
}

const COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|(?:rgb|hsl)a?\([0-9.,%\s/deg-]{3,40}\)|var\(--[a-zA-Z0-9-]{1,40}(?:,\s*#[0-9a-fA-F]{3,8})?\))$/;

/** Só deixa passar cor "de verdade": nada que escape do atributo. */
export function safeColor(value: string | undefined, fallback: string): string {
	return value && COLOR.test(value.trim()) ? value.trim() : fallback;
}

/**
 * Id de máscara seguro para `id=`/`url(#…)`: só letras, números, `_` e `-`.
 * O `useId` do React devolve `«r1»`/`_R_1_`; aqui vira algo estável (o mesmo
 * no servidor e na hidratação) e único por instância.
 */
export function maskId(raw: string): string {
	const clean = raw.replace(/[^a-zA-Z0-9_-]/g, "");
	return `av-${clean || "x"}`;
}

export type EyeMode = "cutout" | "paint";

export type ResolvedEyes = { mode: EyeMode; color: string };

/** Luminância (0–1) de um `#rrggbb`; `null` para qualquer outra cor. */
function luminanceOf(color: string): number | null {
	if (!/^#[0-9a-fA-F]{6}$/.test(color)) return null;
	const r = Number.parseInt(color.slice(1, 3), 16);
	const g = Number.parseInt(color.slice(3, 5), 16);
	const b = Number.parseInt(color.slice(5, 7), 16);
	return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * Corpo quase preto ou quase branco: o recorte mostraria um fundo parecido
 * com o corpo (tema escuro / claro) e o olho sumiria.
 */
function lacksCutoutContrast(color: string): boolean {
	const l = luminanceOf(color);
	return l !== null && (l < 0.2 || l > 0.93);
}

/**
 * Padrão = recorte. Cor de olho explícita pinta o olho; corpo quase preto ou
 * quase branco também pinta (cor de contraste), porque o recorte sumiria.
 */
export function resolveEyes(bodyColor: string, eyeColor?: string): ResolvedEyes {
	if (eyeColor !== undefined) {
		return { mode: "paint", color: safeColor(eyeColor, DEFAULT_EYE_COLOR) };
	}
	if (lacksCutoutContrast(bodyColor)) return { mode: "paint", color: eyeColorFor(bodyColor) };
	return { mode: "cutout", color: DEFAULT_EYE_COLOR };
}

/** Atributos da máscara (região folgada, em unidades do corpo). */
export function maskRegion(): string {
	const { min, size } = MASK_BOX;
	return `maskUnits="userSpaceOnUse" x="${min}" y="${min}" width="${size}" height="${size}"`;
}

export type RenderOptions = {
	/** Largura/altura em px. Sem isso o SVG escala com o contêiner. */
	size?: number;
	color: string;
	/** Cor do olho. Sem ela, o olho é recortado (mostra o fundo). */
	eyeColor?: string;
	/** Prefixo dos ids das máscaras; sem ele, deriva do conteúdo (determinístico). */
	id?: string;
};

/** Frame → `<svg>` completo, decorativo (`aria-hidden`). */
export function renderFrame(frame: Frame, options: RenderOptions): string {
	const body = safeColor(options.color, "#777777");
	const eyes = resolveEyes(body, options.eyeColor);
	const { body: bodyD, eyes: eyesD } = projectFrame(frame);
	const id = maskId(options.id ?? hash(`${bodyD}|${eyesD}|${body}|${eyes.mode}`).toString(36));
	const dims = options.size
		? ` width="${options.size}" height="${options.size}"`
		: "";
	const { min, size } = MASK_BOX;
	let defs: string;
	let inner: string;
	if (eyes.mode === "cutout") {
		defs =
			`<mask id="${id}-holes" ${maskRegion()}>` +
			`<rect x="${min}" y="${min}" width="${size}" height="${size}" fill="#fff"/>` +
			`<path d="${eyesD}" fill="#000"/></mask>`;
		inner = `<g mask="url(#${id}-holes)"><path d="${bodyD}" fill="${body}"/></g>`;
	} else {
		defs =
			`<path id="${id}-body" d="${bodyD}"/>` +
			`<mask id="${id}-inside" ${maskRegion()}><use href="#${id}-body" fill="#fff"/></mask>`;
		inner =
			`<use href="#${id}-body" fill="${body}"/>` +
			`<g mask="url(#${id}-inside)"><path d="${eyesD}" fill="${eyes.color}"/></g>`;
	}
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${AVATAR_VIEWBOX}"${dims} aria-hidden="true" focusable="false">` +
		`<defs>${defs}</defs>` +
		`<g transform="${groupTransform(frame)}">${inner}${frame.indicator ? partsMarkup(frame.indicator.parts, body) : ""}</g></svg>`
	);
}
