// Partes do indicador (discos e anéis) como atributos de <circle>. O avatar
// reserva PART_SLOTS círculos e o ticker só reescreve os atributos que mudam.
import { round2 } from "../geometry/math.js";
import type { Part } from "../model/indicator.js";

/** Maior número de partes de qualquer indicador (a órbita tem 5 discos). */
export const PART_SLOTS = 5;

export type PartAttrs = {
	cx: string;
	cy: string;
	r: string;
	opacity: string;
	fill: string;
	stroke: string;
	"stroke-width": string;
	"stroke-dasharray": string;
	transform: string;
};

/** Círculo escondido (slot sem parte). */
export const HIDDEN_PART: PartAttrs = {
	cx: "0",
	cy: "0",
	r: "0",
	opacity: "0",
	fill: "none",
	stroke: "none",
	"stroke-width": "0",
	"stroke-dasharray": "none",
	transform: "",
};

/** Atributos do círculo para uma parte; `color` é a cor do corpo. */
export function partAttrs(part: Part | undefined, color: string): PartAttrs {
	if (!part) return HIDDEN_PART;
	const base = { cx: String(round2(part.cx)), cy: String(round2(part.cy)), r: String(round2(part.r)), opacity: String(Math.round(part.opacity * 1000) / 1000) };
	if (part.type === "disc") {
		return { ...base, fill: color, stroke: "none", "stroke-width": "0", "stroke-dasharray": "none", transform: "" };
	}
	const circumference = 2 * Math.PI * part.r;
	return {
		...base,
		fill: "none",
		stroke: color,
		"stroke-width": String(round2(part.width)),
		"stroke-dasharray": part.arc
			? `${round2(circumference * part.arc.fraction)} ${round2(circumference)}`
			: "none",
		transform: part.arc ? `rotate(${part.arc.startDeg} ${round2(part.cx)} ${round2(part.cy)})` : "",
	};
}

/** Marcação das partes para o renderer em string. */
export function partsMarkup(parts: readonly Part[], color: string): string {
	return parts
		.map((part) => {
			const a = partAttrs(part, color);
			const transform = a.transform ? ` transform="${a.transform}"` : "";
			return `<circle cx="${a.cx}" cy="${a.cy}" r="${a.r}" fill="${a.fill}" stroke="${a.stroke}" stroke-width="${a["stroke-width"]}" stroke-dasharray="${a["stroke-dasharray"]}" opacity="${a.opacity}"${transform}/>`;
		})
		.join("");
}
