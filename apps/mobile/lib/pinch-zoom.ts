// Matemática do zoom da tela do Computador (função pura, sem React Native): escala 1x–4x, deslocamento preso aos
// limites do quadro, zoom em torno do ponto focal e duplo toque. Coordenadas relativas ao CENTRO da área visível.

export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
/** Escala do duplo toque quando está em 1x. */
export const DOUBLE_TAP_SCALE = 2;
/** Intervalo máximo (ms) entre dois toques para valer como duplo toque. */
export const DOUBLE_TAP_MS = 300;
/** Quanto o dedo pode andar (dp) e ainda contar como toque. */
export const TAP_SLOP = 10;

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type ZoomState = { scale: number; x: number; y: number };

export const ZOOM_RESET: ZoomState = { scale: MIN_SCALE, x: 0, y: 0 };

/** Prende a escala entre 1x e 4x (valor inválido volta para 1x). */
export function clampScale(scale: number): number {
	if (!Number.isFinite(scale)) return MIN_SCALE;
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Deslocamento máximo (em módulo) em cada eixo: a imagem ampliada pode andar até a borda dela encostar na borda da
 * tela. Se ela ainda cabe inteira no eixo (ex.: quadro 16:9 numa tela alta), não anda naquele eixo.
 */
export function maxOffset(frame: Size, viewport: Size, scale: number): Point {
	const s = clampScale(scale);
	return {
		x: Math.max(0, (frame.width * s - viewport.width) / 2),
		y: Math.max(0, (frame.height * s - viewport.height) / 2),
	};
}

function clampAxis(value: number, limit: number): number {
	// `+ 0` evita o -0 (que o toEqual distingue de 0).
	return Math.min(limit, Math.max(-limit, value)) + 0;
}

/** Prende o estado: escala 1–4 e deslocamento dentro do limite (em 1x vira 0,0). */
export function clampZoom(state: ZoomState, frame: Size, viewport: Size): ZoomState {
	const scale = clampScale(state.scale);
	const limit = maxOffset(frame, viewport, scale);
	return { scale, x: clampAxis(state.x, limit.x), y: clampAxis(state.y, limit.y) };
}

/** Muda a escala mantendo parado o ponto da imagem que está sob `focal`. */
export function zoomAround(state: ZoomState, nextScale: number, focal: Point, frame: Size, viewport: Size): ZoomState {
	const scale = clampScale(nextScale);
	const ratio = scale / state.scale;
	return clampZoom({ scale, x: focal.x - (focal.x - state.x) * ratio, y: focal.y - (focal.y - state.y) * ratio }, frame, viewport);
}

/** Arrastar com um dedo: só anda quando ampliado (em 1x o clamp zera). */
export function panBy(start: ZoomState, dx: number, dy: number, frame: Size, viewport: Size): ZoomState {
	return clampZoom({ scale: start.scale, x: start.x + dx, y: start.y + dy }, frame, viewport);
}

export type PinchSample = { distance: number; center: Point };

/** Pinça de dois dedos: escala pela razão das distâncias, em torno do ponto inicial, seguindo o movimento do centro. */
export function pinchTransform(start: ZoomState, from: PinchSample, now: PinchSample, frame: Size, viewport: Size): ZoomState {
	if (!(from.distance > 0)) return clampZoom(start, frame, viewport);
	const scale = clampScale(start.scale * (now.distance / from.distance));
	const ratio = scale / start.scale;
	return clampZoom(
		{
			scale,
			x: now.center.x - (from.center.x - start.x) * ratio,
			y: now.center.y - (from.center.y - start.y) * ratio,
		},
		frame,
		viewport,
	);
}

/** Duplo toque: ampliado volta a 1x; em 1x vai a 2x em torno do toque. */
export function doubleTapZoom(state: ZoomState, focal: Point, frame: Size, viewport: Size): ZoomState {
	return state.scale > MIN_SCALE ? ZOOM_RESET : zoomAround(state, DOUBLE_TAP_SCALE, focal, frame, viewport);
}

/** O segundo toque vale como duplo toque se veio logo depois do primeiro. */
export function isDoubleTap(previousTapAt: number | null, now: number): boolean {
	return previousTapAt !== null && now - previousTapAt <= DOUBLE_TAP_MS;
}

/** O gesto foi um toque (e não arrasto): dedo quase parado. */
export function isTap(dx: number, dy: number): boolean {
	return Math.hypot(dx, dy) <= TAP_SLOP;
}

export function distanceBetween(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Quem recebe os dedos na tela do Computador. `off`: ninguém (ainda conectando). `view` (somente ver): o zoom captura tudo
 * (um dedo arrasta o quadro, dois dão a pinça). `control`: o zoom captura SÓ gestos de dois dedos ou mais (pinça e arrastar
 * o quadro com dois dedos); um dedo passa para a VM (toque, arrasto e toque longo viram mouse no noVNC).
 */
export type ZoomMode = "off" | "view" | "control";

/** O zoom deve capturar este toque (`touchCount` = dedos na tela)? */
export function zoomCapturesTouch(mode: ZoomMode, touchCount: number): boolean {
	if (mode === "off") return false;
	if (mode === "view") return touchCount >= 1;
	return touchCount >= 2;
}

/** Ampliado o bastante para mostrar o botão "1x" (folga para o arredondamento da animação). */
export function isZoomed(scale: number): boolean {
	return scale > 1.01;
}
