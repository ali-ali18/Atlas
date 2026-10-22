"use client";

import { type MouseEvent, type PointerEvent, useCallback, useEffect, useRef } from "react";

/** Tempo segurando para contar como "pressão longa" no toque. */
export const LONG_PRESS_MS = 450;
/** Quanto o dedo pode andar (px) antes de virar rolagem e cancelar a pressão. */
export const LONG_PRESS_MOVE_TOLERANCE = 10;

export type PressPoint = { x: number; y: number };

/** O dedo se afastou o bastante do ponto inicial para cancelar a pressão longa? Pura. */
export function pressMoved(origin: PressPoint, current: PressPoint, tolerance = LONG_PRESS_MOVE_TOLERANCE): boolean {
	return Math.hypot(current.x - origin.x, current.y - origin.y) > tolerance;
}

/** A pressão dura o suficiente? Pura (o relógio é injetado). */
export function isLongPress(startedAt: number, now: number, delay = LONG_PRESS_MS): boolean {
	return now - startedAt >= delay;
}

/**
 * Pressão longa só para toque (mouse e caneta usam hover/foco). Devolve handlers para espalhar no elemento.
 * Depois que a pressão longa dispara, o clique que o navegador gera ao soltar o dedo é engolido, para não
 * abrir o item por engano.
 */
export function useLongPress(onLongPress: () => void, delay = LONG_PRESS_MS) {
	const timer = useRef<number | undefined>(undefined);
	const origin = useRef<PressPoint | null>(null);
	const fired = useRef(false);
	const callback = useRef(onLongPress);
	callback.current = onLongPress;

	const cancel = useCallback(() => {
		window.clearTimeout(timer.current);
		timer.current = undefined;
		origin.current = null;
	}, []);

	useEffect(() => cancel, [cancel]);

	return {
		onPointerDown(event: PointerEvent) {
			if (event.pointerType !== "touch") return;
			fired.current = false;
			origin.current = { x: event.clientX, y: event.clientY };
			window.clearTimeout(timer.current);
			timer.current = window.setTimeout(() => {
				fired.current = true;
				timer.current = undefined;
				callback.current();
			}, delay);
		},
		onPointerMove(event: PointerEvent) {
			if (origin.current && pressMoved(origin.current, { x: event.clientX, y: event.clientY })) cancel();
		},
		onPointerUp: cancel,
		onPointerCancel: cancel,
		onClickCapture(event: MouseEvent) {
			if (!fired.current) return;
			fired.current = false;
			event.preventDefault();
			event.stopPropagation();
		},
		onContextMenu(event: MouseEvent) {
			// Menu nativo de "segurar" no celular atropelaria o gesto.
			if (fired.current || origin.current) event.preventDefault();
		},
	};
}
