import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { makeModelCopy, processImageForStorage } from "./process.js";

describe("processImageForStorage", () => {
	it("reencoda e reduz imagem grande", async () => {
		const bytes = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: "blue" } }).jpeg().toBuffer();
		const stored = await processImageForStorage(bytes);
		expect(stored.width).toBe(2048);
		expect(stored.height).toBe(1024);
		const model = await makeModelCopy(stored.bytes);
		expect(model).toMatch(/^data:image\/jpeg;base64,/);
		const modelMeta = await sharp(Buffer.from(model.split(",")[1]!, "base64")).metadata();
		expect(modelMeta.width).toBe(1568);
	});

	it("recusa HTML ou SVG disfarçados de imagem", async () => {
		await expect(processImageForStorage(Buffer.from("<html>não é png</html>"))).rejects.toThrow("Formato");
		await expect(processImageForStorage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).rejects.toThrow("Formato");
	});
});
