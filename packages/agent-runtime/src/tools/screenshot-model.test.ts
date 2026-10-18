import { describe, expect, it, vi } from "vitest";
import { captureModelScreenshot, modelPointToScreen } from "./screenshot-model.js";

function fakeManager(width: number, height: number, image?: Buffer) {
	return {
		execScreen: vi.fn(async () => ({ width, height })),
		execScreenshot: vi.fn(async () => image ?? jpegBuffer(Math.round(width * Math.min(1, 1024 / width)), Math.round(height * Math.min(1, 1024 / width)))),
	};
}

function pngBuffer(width: number, height: number) {
	const b = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
	b.writeUInt32BE(width, 16);
	b.writeUInt32BE(height, 20);
	return b;
}

function jpegBuffer(width: number, height: number) {
	return Buffer.from([
		0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08,
		height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00,
	]);
}

describe("captureModelScreenshot", () => {
	it("pede JPEG reduzido a 80% (1280 -> 1024) e informa o tamanho ao modelo", async () => {
		const manager = fakeManager(1280, 720);
		const shot = await captureModelScreenshot(manager as never, "s-a");
		expect(manager.execScreenshot).toHaveBeenCalledWith("s-a", {
			scalePercent: 80,
			jpegQuality: 70,
		});
		expect(shot.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
		expect(shot.summary).toContain("1024x576");
		expect(shot.summary).toContain("model analysis");
		expect(shot.summary).toContain("user has not received");
		expect(shot.summary).toContain("show_image");
	});

	it("o clique do modelo volta para a tela real (x1.25)", async () => {
		await captureModelScreenshot(fakeManager(1280, 720) as never, "s-b");
		expect(modelPointToScreen("s-b", 512, 288)).toEqual({ x: 640, y: 360 });
	});

	it("sessão sem screenshot ou tela <= 1024: coordenadas intactas", async () => {
		expect(modelPointToScreen("s-never", 10, 20)).toEqual({ x: 10, y: 20 });
		await captureModelScreenshot(fakeManager(800, 600) as never, "s-c");
		expect(modelPointToScreen("s-c", 10, 20)).toEqual({ x: 10, y: 20 });
	});

	it("sandbox antigo devolve PNG cheio: usa o tamanho real, clique não desloca", async () => {
		const manager = fakeManager(1280, 720, pngBuffer(1280, 720));
		const shot = await captureModelScreenshot(manager as never, "s-old");
		expect(shot.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
		expect(shot.summary).toContain("1280x720");
		expect(modelPointToScreen("s-old", 400, 300)).toEqual({ x: 400, y: 300 });
	});

	it("bytes ilegíveis: escala 1 e o resumo avisa", async () => {
		const manager = fakeManager(1280, 720, Buffer.from([1, 2, 3]));
		const shot = await captureModelScreenshot(manager as never, "s-junk");
		expect(shot.summary).toContain("not identified");
		expect(modelPointToScreen("s-junk", 400, 300)).toEqual({ x: 400, y: 300 });
	});

	it("sem geometria da tela, ainda captura (escala 100)", async () => {
		const manager = {
			execScreen: vi.fn(async () => {
				throw new Error("x");
			}),
			execScreenshot: vi.fn(async () => Buffer.from([1])),
		};
		const shot = await captureModelScreenshot(manager as never, "s-d");
		expect(shot.summary).toContain("not identified");
	});
});

describe("screenshot com region (zoom) e marks", () => {
	it("região em coords da imagem vira recorte na tela real e o clique soma a origem", async () => {
		await captureModelScreenshot(fakeManager(1280, 720) as never, "s-z");
		// região 100,100 200x100 na imagem 1024 => tela 125,125 250x125
		const crop = {
			execScreen: vi.fn(async () => ({ width: 1280, height: 720 })),
			execScreenshot: vi.fn(async () => jpegBuffer(250, 125)),
		};
		const shot = await captureModelScreenshot(crop as never, "s-z", {
			region: { x: 100, y: 100, width: 200, height: 100 },
			marks: true,
		});
		expect(crop.execScreenshot).toHaveBeenCalledWith("s-z", {
			scalePercent: 100,
			jpegQuality: 70,
			region: { x: 125, y: 125, width: 250, height: 125 },
			marks: true,
		});
		expect(shot.summary).toContain("Zoom");
		expect(shot.summary).toContain("user has not received");
		expect(shot.summary).toContain("refs");
		expect(modelPointToScreen("s-z", 10, 20)).toEqual({ x: 135, y: 145 });
	});

	it("VM antiga ignora region e devolve tela inteira: trata como inteira", async () => {
		await captureModelScreenshot(fakeManager(1280, 720, pngBuffer(1280, 720)) as never, "s-zo");
		const old = fakeManager(1280, 720, pngBuffer(1280, 720));
		const shot = await captureModelScreenshot(old as never, "s-zo", {
			region: { x: 100, y: 100, width: 200, height: 100 },
		});
		expect(shot.summary).toContain("ignored");
		expect(modelPointToScreen("s-zo", 400, 300)).toEqual({ x: 400, y: 300 });
	});

	it("parseScreenshotArgs rejeita região inválida", async () => {
		const { parseScreenshotArgs } = await import("./screenshot-model.js");
		expect(parseScreenshotArgs({ region: { x: 1, y: 1, width: 2, height: 50 } })).toEqual({});
		expect(parseScreenshotArgs({ region: "x", marks: true })).toEqual({ marks: true });
		expect(parseScreenshotArgs({ region: { x: 1, y: 2, width: 30, height: 40 } }).region).toEqual({ x: 1, y: 2, width: 30, height: 40 });
	});
});
