import { describe, expect, it } from "vitest";
import { clampScale, clampZoom, distanceBetween, doubleTapZoom, isDoubleTap, isTap, maxOffset, midpoint, panBy, pinchTransform, ZOOM_RESET, zoomAround } from "./pinch-zoom";

const viewport = { width: 400, height: 800 };
const frame = { width: 400, height: 225 }; // 16:9 preenchendo a largura

describe("clampScale", () => {
	it("prende entre 1x e 4x", () => {
		expect(clampScale(0.3)).toBe(1);
		expect(clampScale(2.5)).toBe(2.5);
		expect(clampScale(9)).toBe(4);
		expect(clampScale(Number.NaN)).toBe(1);
	});
});

describe("maxOffset", () => {
	it("em 1x não anda", () => {
		expect(maxOffset(frame, viewport, 1)).toEqual({ x: 0, y: 0 });
	});
	it("anda até a borda da imagem encostar na da tela; eixo que ainda cabe fica parado", () => {
		// 2x: 800 de largura (folga 400, metade 200); altura 450 < 800 cabe, então 0.
		expect(maxOffset(frame, viewport, 2)).toEqual({ x: 200, y: 0 });
		// 4x: altura 900 > 800 passa a andar 50.
		expect(maxOffset(frame, viewport, 4)).toEqual({ x: 600, y: 50 });
	});
});

describe("clampZoom / panBy", () => {
	it("a imagem não sai dos limites", () => {
		expect(clampZoom({ scale: 2, x: 999, y: -999 }, frame, viewport)).toEqual({ scale: 2, x: 200, y: 0 });
		expect(panBy({ scale: 2, x: 150, y: 0 }, 100, 40, frame, viewport)).toEqual({ scale: 2, x: 200, y: 0 });
		expect(panBy({ scale: 4, x: 0, y: 0 }, -900, -90, frame, viewport)).toEqual({ scale: 4, x: -600, y: -50 });
	});
	it("em 1x arrastar não move", () => {
		expect(panBy(ZOOM_RESET, 80, 80, frame, viewport)).toEqual(ZOOM_RESET);
	});
});

describe("zoomAround", () => {
	it("mantém parado o ponto sob o foco", () => {
		const next = zoomAround(ZOOM_RESET, 2, { x: 100, y: 0 }, frame, viewport);
		// ponto da imagem sob o foco: (100 - x) / scale continua 100
		expect((100 - next.x) / next.scale).toBeCloseTo(100);
		expect(next.scale).toBe(2);
	});
	it("foco no centro não desloca", () => {
		expect(zoomAround(ZOOM_RESET, 3, { x: 0, y: 0 }, frame, viewport)).toEqual({ scale: 3, x: 0, y: 0 });
	});
	it("passou de 4x fica em 4x e o deslocamento respeita o limite", () => {
		const next = zoomAround(ZOOM_RESET, 10, { x: 400, y: 0 }, frame, viewport);
		expect(next.scale).toBe(4);
		expect(Math.abs(next.x)).toBeLessThanOrEqual(600);
	});
});

describe("pinchTransform", () => {
	const from = { distance: 100, center: { x: 0, y: 0 } };
	it("afastar os dedos amplia pela razão das distâncias", () => {
		const next = pinchTransform(ZOOM_RESET, from, { distance: 250, center: { x: 0, y: 0 } }, frame, viewport);
		expect(next).toEqual({ scale: 2.5, x: 0, y: 0 });
	});
	it("não passa de 4x nem fica abaixo de 1x", () => {
		expect(pinchTransform(ZOOM_RESET, from, { distance: 1000, center: { x: 0, y: 0 } }, frame, viewport).scale).toBe(4);
		expect(pinchTransform({ scale: 2, x: 50, y: 0 }, from, { distance: 10, center: { x: 0, y: 0 } }, frame, viewport)).toEqual(ZOOM_RESET);
	});
	it("o centro dos dedos arrastando leva a imagem junto", () => {
		const next = pinchTransform({ scale: 2, x: 0, y: 0 }, from, { distance: 100, center: { x: -60, y: 0 } }, frame, viewport);
		expect(next).toEqual({ scale: 2, x: -60, y: 0 });
	});
	it("distância inicial zero não quebra", () => {
		expect(pinchTransform(ZOOM_RESET, { distance: 0, center: { x: 0, y: 0 } }, { distance: 50, center: { x: 0, y: 0 } }, frame, viewport)).toEqual(ZOOM_RESET);
	});
});

describe("doubleTapZoom", () => {
	it("em 1x vai a 2x em torno do toque; ampliado volta a 1x", () => {
		const zoomed = doubleTapZoom(ZOOM_RESET, { x: 100, y: 0 }, frame, viewport);
		expect(zoomed.scale).toBe(2);
		expect(doubleTapZoom(zoomed, { x: 0, y: 0 }, frame, viewport)).toEqual(ZOOM_RESET);
	});
});

describe("toques", () => {
	it("duplo toque só dentro do intervalo", () => {
		expect(isDoubleTap(null, 1000)).toBe(false);
		expect(isDoubleTap(900, 1000)).toBe(true);
		expect(isDoubleTap(500, 1000)).toBe(false);
	});
	it("toque = dedo quase parado", () => {
		expect(isTap(2, 3)).toBe(true);
		expect(isTap(20, 0)).toBe(false);
	});
	it("distância e ponto médio", () => {
		expect(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
		expect(midpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
	});
});
