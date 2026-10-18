import { describe, expect, it } from "vitest";
import {
	scalePointToScreen,
	sniffImageMime,
	scaledScreenshotSize,
	screenshotScalePercent,
} from "./screenshot-scale.js";

describe("screenshotScalePercent", () => {
	it("1280 de largura vira 80%; telas pequenas ou inválidas não reduzem", () => {
		expect(screenshotScalePercent(1280)).toBe(80);
		expect(screenshotScalePercent(1920)).toBe(53);
		expect(screenshotScalePercent(1024)).toBe(100);
		expect(screenshotScalePercent(800)).toBe(100);
		expect(screenshotScalePercent(0)).toBe(100);
		expect(screenshotScalePercent(Number.NaN)).toBe(100);
	});
});

describe("scaledScreenshotSize", () => {
	it("1280x720 a 80% é 1024x576", () => {
		expect(scaledScreenshotSize({ width: 1280, height: 720 }, 80)).toEqual({
			width: 1024,
			height: 576,
		});
	});
});

describe("scalePointToScreen", () => {
	it("converte da imagem reduzida de volta para a tela", () => {
		expect(scalePointToScreen({ x: 512, y: 288 }, 80)).toEqual({ x: 640, y: 360 });
		expect(scalePointToScreen({ x: 100, y: 100 }, 100)).toEqual({ x: 100, y: 100 });
	});

	it("round-trip dentro de 1 px e clamp nas bordas da tela", () => {
		const screen = { width: 1280, height: 720 };
		const shown = { x: Math.round(777 * 0.8), y: Math.round(333 * 0.8) };
		const back = scalePointToScreen(shown, 80, screen);
		expect(Math.abs(back.x - 777)).toBeLessThanOrEqual(1);
		expect(Math.abs(back.y - 333)).toBeLessThanOrEqual(1);
		expect(scalePointToScreen({ x: 5000, y: -4 }, 80, screen)).toEqual({ x: 1279, y: 0 });
	});
});

describe("sniffImageMime", () => {
	it("reconhece JPEG e cai em PNG para o resto", () => {
		expect(sniffImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
		expect(sniffImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBe("image/png");
		expect(sniffImageMime(new Uint8Array())).toBe("image/png");
	});
});

import { imagePointToScreen, readImageSize, screenshotFactorFromSize } from "./screenshot-scale.js";

function png(width: number, height: number): Uint8Array {
	const b = new Uint8Array(33);
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	new DataView(b.buffer).setUint32(16, width);
	new DataView(b.buffer).setUint32(20, height);
	return b;
}

function jpeg(width: number, height: number): Uint8Array {
	// SOI, APP0 (len 4), SOF0 (len 11)
	return Uint8Array.from([
		0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08,
		height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00,
	]);
}

describe("readImageSize", () => {
	it("lê PNG e JPEG", () => {
		expect(readImageSize(png(1280, 720))).toEqual({ width: 1280, height: 720 });
		expect(readImageSize(jpeg(1024, 576))).toEqual({ width: 1024, height: 576 });
	});
	it("lixo, vazio e truncado → null", () => {
		expect(readImageSize(new Uint8Array())).toBeNull();
		expect(readImageSize(Uint8Array.from([1, 2, 3, 4, 5]))).toBeNull();
		expect(readImageSize(Uint8Array.from([0xff, 0xd8, 0xff]))).toBeNull();
		expect(readImageSize(png(1280, 720).slice(0, 20))).toBeNull();
		expect(readImageSize(png(0, 720))).toBeNull();
		expect(readImageSize(jpeg(1024, 576).slice(0, 14))).toBeNull();
	});
});

describe("screenshotFactorFromSize / imagePointToScreen", () => {
	const screen = { width: 1280, height: 720 };
	it("imagem cheia (sandbox antigo) → fator 1, sem deslocar clique", () => {
		const f = screenshotFactorFromSize({ width: 1280, height: 720 }, screen);
		expect(imagePointToScreen({ x: 400, y: 300 }, f, screen)).toEqual({ x: 400, y: 300 });
	});
	it("imagem reduzida 1024x576 → x1.25", () => {
		const f = screenshotFactorFromSize({ width: 1024, height: 576 }, screen);
		expect(imagePointToScreen({ x: 512, y: 288 }, f, screen)).toEqual({ x: 640, y: 360 });
	});
	it("eixos divergentes (>2%) usam fator por eixo", () => {
		const f = screenshotFactorFromSize({ width: 640, height: 720 }, screen);
		expect(imagePointToScreen({ x: 320, y: 360 }, f, screen)).toEqual({ x: 640, y: 360 });
	});
	it("tamanho desconhecido → 1; clamp na borda", () => {
		const f = screenshotFactorFromSize(null, screen);
		expect(f).toEqual({ x: 1, y: 1 });
		expect(imagePointToScreen({ x: 5000, y: -3 }, f, screen)).toEqual({ x: 1279, y: 0 });
	});
});
