/** Limites compartilhados para anexos de imagem. */
export const IMAGE_LIMITS = {
	maxBytes: 10 * 1024 * 1024,
	maxPerMessage: 4,
	maxModelEdge: 1568,
	maxStoredEdge: 2048,
	maxUserImagesInContext: 4,
} as const;

export const ALLOWED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ImageMime = (typeof ALLOWED_IMAGE_MIMES)[number];

export function sniffImageType(bytes: Uint8Array): ImageMime | null {
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 6 && String.fromCharCode(...bytes.subarray(0, 6)) === "GIF87a") return "image/gif";
	if (bytes.length >= 6 && String.fromCharCode(...bytes.subarray(0, 6)) === "GIF89a") return "image/gif";
	if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
	return null;
}

export function scaledImageSize(width: number, height: number, maxEdge: number): { width: number; height: number } | null {
	if (![width, height, maxEdge].every((value) => Number.isFinite(value) && value > 0)) return null;
	const scale = Math.min(1, maxEdge / Math.max(width, height));
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function artifactImageRef(id: string): string {
	return `artifact:${id}`;
}

export function imageMarker(input: { name?: string; description?: string; index: number }): string {
	const label = (input.description || input.name || `image ${input.index}`).replace(/[\r\n\"]+/g, " ").trim().slice(0, 120);
	return `[image omitted: "${label}"]`;
}
