import type { GroupPosition } from "@workspace/shared";

/** Raio grande do balão no app (21 dp, medido no Grok) e o pequeno da ponta que encosta na fala vizinha (6, o `md` do web). */
export const BUBBLE_RADIUS = 21;
export const BUBBLE_RADIUS_JOINED = 6;

export type BubbleCorners = {
	borderTopLeftRadius: number;
	borderTopRightRadius: number;
	borderBottomRightRadius: number;
	borderBottomLeftRadius: number;
};

/**
 * Cantos do balão no estilo "conectado" (mesma regra do `bubbleRadius` compartilhado com o web, que fica em 16), mas com o
 * raio de 21 do Grok, só no app. A ponta onde o balão encosta na vizinha do mesmo autor fica com o raio pequeno.
 */
export function bubbleCorners(side: "left" | "right", position: GroupPosition): BubbleCorners {
	const big = BUBBLE_RADIUS;
	const small = BUBBLE_RADIUS_JOINED;
	const corners = { borderTopLeftRadius: big, borderTopRightRadius: big, borderBottomRightRadius: big, borderBottomLeftRadius: big };
	if (position === "single") return corners;
	// Esquerda (bot): a ponta junto da vizinha é a da esquerda; direita (usuário): a da direita.
	const joinedTop = position === "middle" || position === "last";
	const joinedBottom = position === "first" || position === "middle";
	if (side === "left") {
		if (joinedTop) corners.borderTopLeftRadius = small;
		if (joinedBottom) corners.borderBottomLeftRadius = small;
	} else {
		if (joinedTop) corners.borderTopRightRadius = small;
		if (joinedBottom) corners.borderBottomRightRadius = small;
	}
	return corners;
}

/**
 * Balão colado numa tabela (mesma fala): o cartão da tabela é todo arredondado, então a ponta do balão que encosta nele
 * também fica em 21 (a ponta reta de "falas seguidas" só vale entre balões). `hasAbove`/`hasBelow`: há tabela em cima/embaixo.
 */
export function cornersNextToTable(base: BubbleCorners, side: "left" | "right", hasAbove: boolean, hasBelow: boolean): BubbleCorners {
	const corners = { ...base };
	const top = side === "left" ? "borderTopLeftRadius" : "borderTopRightRadius";
	const bottom = side === "left" ? "borderBottomLeftRadius" : "borderBottomRightRadius";
	if (hasAbove) corners[top] = BUBBLE_RADIUS;
	if (hasBelow) corners[bottom] = BUBBLE_RADIUS;
	return corners;
}
