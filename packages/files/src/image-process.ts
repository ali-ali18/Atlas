import sharp from "sharp";
import { IMAGE_LIMITS, sniffImageType } from "@workspace/shared";

const MAX_INPUT_EDGE = 8_000;
const MAX_INPUT_PIXELS = 40_000_000;

export type ProcessedImage = {
	bytes: Buffer;
	mime: "image/jpeg" | "image/png";
	width: number;
	height: number;
};

function assertImageInput(bytes: Uint8Array): void {
	if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_LIMITS.maxBytes) {
		throw new Error("Imagem vazia ou acima de 10 MB.");
	}
	if (!sniffImageType(bytes)) throw new Error("Formato de imagem não aceito. Use PNG, JPEG, WebP ou GIF.");
}

async function encodeImage(bytes: Uint8Array, maxEdge: number): Promise<ProcessedImage> {
	assertImageInput(bytes);
	const input = sharp(bytes, { animated: false, limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
	const metadata = await input.metadata();
	if (!metadata.width || !metadata.height || metadata.width > MAX_INPUT_EDGE || metadata.height > MAX_INPUT_EDGE || metadata.width * metadata.height > MAX_INPUT_PIXELS) {
		throw new Error("Dimensões de imagem acima do limite.");
	}
	// Reencodar sem withMetadata remove EXIF/GPS e usa somente o primeiro quadro do GIF.
	const pipeline = input.rotate().resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true });
	const keepAlpha = metadata.hasAlpha === true && metadata.width * metadata.height <= 4_000_000;
	const encoded = keepAlpha ? pipeline.png() : pipeline.jpeg({ quality: 85, mozjpeg: true });
	const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
	return { bytes: data, mime: keepAlpha ? "image/png" : "image/jpeg", width: info.width, height: info.height };
}

export function processImageForStorage(bytes: Uint8Array): Promise<ProcessedImage> {
	return encodeImage(bytes, IMAGE_LIMITS.maxStoredEdge);
}

export async function makeModelCopy(bytes: Uint8Array): Promise<string> {
	const image = await encodeImage(bytes, IMAGE_LIMITS.maxModelEdge);
	return `data:${image.mime};base64,${image.bytes.toString("base64")}`;
}
