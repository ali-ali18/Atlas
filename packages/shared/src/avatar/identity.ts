// Identidade: id → { forma, cor, semente }. Quem não escolheu nada tem um
// visual fixo (o mesmo id sempre dá o mesmo avatar). Também traduz os valores
// que bots antigos guardaram (formas "rond", "goutte"... e cores em hex).
import { hash } from "./geometry/math.js";
import { DRAWABLE_SHAPES, isShape, type Shape } from "./geometry/shapes.js";

export type AvatarColor = { id: string; name: string; value: string };

/** Paleta: tons chapados com bom contraste para olhos escuros. */
export const AVATAR_COLORS: readonly AvatarColor[] = [
	{ id: "black", name: "Preto", value: "#000000" },
	{ id: "brown", name: "Marrom", value: "#936439" },
	{ id: "red", name: "Vermelho", value: "#FF263C" },
	{ id: "orange", name: "Laranja", value: "#FF6700" },
	{ id: "yellow", name: "Amarelo", value: "#FF9800" },
	{ id: "green", name: "Verde", value: "#00C972" },
	{ id: "cyan", name: "Turquesa", value: "#00BCA6" },
	{ id: "blue", name: "Azul", value: "#1084FE" },
	{ id: "violet", name: "Violeta", value: "#9159FE" },
	{ id: "magenta", name: "Rosa", value: "#FF309B" },
	{ id: "gray", name: "Cinza", value: "#777777" },
];

/** Cores sorteáveis por id (o preto fica de fora: só por escolha). */
const HASHED_COLORS = AVATAR_COLORS.filter((c) => c.id !== "black");

export type AvatarIdentity = { shape: Shape; color: string; seed: number };

/** Mistura de bits extra para o índice da forma não acompanhar o da cor. */
function mix(value: number): number {
	let h = value | 0;
	h = Math.imul(h ^ (h >>> 16), 73244475);
	h = Math.imul(h ^ (h >>> 13), 3266489909);
	return (h ^ (h >>> 16)) >>> 0;
}

export function identityFor(id: string): AvatarIdentity {
	const base = hash(id);
	return {
		shape: DRAWABLE_SHAPES[mix(base) % DRAWABLE_SHAPES.length] as Shape,
		color: (HASHED_COLORS[hash(`${id}#color`) % HASHED_COLORS.length] as AvatarColor).value,
		seed: base,
	};
}

/** Formas do primeiro desenho do bloub → formas do motor. */
const LEGACY_SHAPES: Record<string, Shape> = {
	rond: "blob",
	goutte: "teardrop",
	nuage: "cloud",
	hexagone: "hex",
	triangle: "wedge",
	capsule: "capsule",
	squircle: "squircle",
	galet: "pebble",
};

/** Aceita forma nova ou antiga; `undefined` se não reconhece. */
export function normalizeShape(value: string | null | undefined): Shape | undefined {
	if (!value) return undefined;
	if (isShape(value)) return value;
	return LEGACY_SHAPES[value];
}

/** Forma efetiva: a escolhida (nova ou antiga) ou a sorteada pelo id. */
export function resolveShape(shape: string | null | undefined, id: string): Shape {
	return normalizeShape(shape) ?? identityFor(id).shape;
}

/** Cor efetiva: a escolhida (qualquer cor válida) ou a sorteada pelo id. */
export function resolveColor(color: string | null | undefined, id: string): string {
	return color?.trim() ? color.trim() : identityFor(id).color;
}

/** Olho escuro, exceto em corpo (quase) preto, onde fica claro. */
export function eyeColorFor(bodyColor: string): string {
	const hex = bodyColor.replace("#", "");
	if (hex.length < 6) return "#0a0a0c";
	const r = Number.parseInt(hex.slice(0, 2), 16);
	const g = Number.parseInt(hex.slice(2, 4), 16);
	const b = Number.parseInt(hex.slice(4, 6), 16);
	const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return luminance < 0.2 ? "#f9f9f9" : "#0a0a0c";
}
