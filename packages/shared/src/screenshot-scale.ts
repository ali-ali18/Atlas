/**
 * Screenshots enviadas ao modelo são reduzidas (largura máx. 1024 px, JPEG
 * q70): imagem 1280x720 em PNG pesa ~1,5k tokens a mais e o modelo não ganha
 * nada com os pixels extras. O modelo clica nas coordenadas da IMAGEM que vê;
 * estas funções puras convertem de volta para a tela real.
 */
export const SCREENSHOT_MODEL_MAX_WIDTH = 1024;
export const SCREENSHOT_JPEG_QUALITY = 70;

/** Percentual (1..100) a que a tela é reduzida; 100 = sem redução. */
export function screenshotScalePercent(
	screenWidth: number,
	maxWidth: number = SCREENSHOT_MODEL_MAX_WIDTH,
): number {
	if (!Number.isFinite(screenWidth) || screenWidth <= 0) return 100;
	if (screenWidth <= maxWidth) return 100;
	return Math.max(1, Math.min(100, Math.floor((maxWidth / screenWidth) * 100)));
}

/** Tamanho da imagem entregue ao modelo para uma tela e escala dadas. */
export function scaledScreenshotSize(
	screen: { width: number; height: number },
	percent: number,
): { width: number; height: number } {
	const factor = clampPercent(percent) / 100;
	return {
		width: Math.max(1, Math.round(screen.width * factor)),
		height: Math.max(1, Math.round(screen.height * factor)),
	};
}

/** Ponto da imagem reduzida (visto pelo modelo) → ponto da tela real. */
export function scalePointToScreen(
	point: { x: number; y: number },
	percent: number,
	screen?: { width: number; height: number },
): { x: number; y: number } {
	const factor = 100 / clampPercent(percent);
	const x = Math.round(point.x * factor);
	const y = Math.round(point.y * factor);
	if (!screen) return { x, y };
	return {
		x: Math.min(Math.max(0, x), Math.max(0, screen.width - 1)),
		y: Math.min(Math.max(0, y), Math.max(0, screen.height - 1)),
	};
}

function clampPercent(percent: number): number {
	return Number.isFinite(percent) ? Math.min(100, Math.max(1, percent)) : 100;
}

/** Formato real da imagem pelos magic bytes (JPEG vs PNG), sem confiar em extensão. */
export function sniffImageMime(bytes: Uint8Array): "image/jpeg" | "image/png" {
	return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
		? "image/jpeg"
		: "image/png";
}

/**
 * Largura/altura reais lidas dos bytes (PNG: IHDR; JPEG: marcador SOFn).
 * Imagem de sandbox antiga ignora `scalePct` e devolve PNG cheio; confiar na
 * escala pedida deslocaria os cliques. Bytes inválidos/truncados → null.
 */
export function readImageSize(
	bytes: Uint8Array,
): { width: number; height: number } | null {
	return readPngSize(bytes) ?? readJpegSize(bytes);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readPngSize(b: Uint8Array): { width: number; height: number } | null {
	if (b.length < 24) return null;
	for (let i = 0; i < PNG_SIGNATURE.length; i++) if (b[i] !== PNG_SIGNATURE[i]) return null;
	// Chunk IHDR: tamanho(4) "IHDR"(4) largura(4) altura(4).
	if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null;
	const width = u32(b, 16);
	const height = u32(b, 20);
	return validSize(width, height);
}

function readJpegSize(b: Uint8Array): { width: number; height: number } | null {
	if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
	let i = 2;
	while (i + 3 < b.length) {
		if (b[i] !== 0xff) return null;
		let marker = b[i + 1] as number;
		while (marker === 0xff && i + 2 < b.length) {
			i++;
			marker = b[i + 1] as number;
		}
		i += 2;
		// Marcadores sem payload.
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		if (marker === 0xd9 || marker === 0xda) return null;
		if (i + 1 >= b.length) return null;
		const length = ((b[i] as number) << 8) | (b[i + 1] as number);
		const isSof =
			marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isSof) {
			if (i + 6 >= b.length) return null;
			const height = ((b[i + 3] as number) << 8) | (b[i + 4] as number);
			const width = ((b[i + 5] as number) << 8) | (b[i + 6] as number);
			return validSize(width, height);
		}
		if (length < 2) return null;
		i += length;
	}
	return null;
}

function u32(b: Uint8Array, o: number): number {
	return (
		(((b[o] as number) << 24) |
			((b[o + 1] as number) << 16) |
			((b[o + 2] as number) << 8) |
			(b[o + 3] as number)) >>>
		0
	);
}

function validSize(width: number, height: number): { width: number; height: number } | null {
	return width > 0 && height > 0 && width <= 65535 && height <= 65535 ? { width, height } : null;
}

export type ScreenshotFactor = { x: number; y: number };

/**
 * Fator imagem/tela (<=1 quando reduzida) a partir do tamanho REAL da imagem.
 * Eixos que diferem mais de 2% ficam separados; senão usa um fator só (evita
 * erro de arredondamento). Tamanho desconhecido → 1 (coordenadas intactas).
 */
export function screenshotFactorFromSize(
	image: { width: number; height: number } | null,
	screen: { width: number; height: number } | null,
): ScreenshotFactor {
	if (!image || !screen || screen.width <= 0 || screen.height <= 0) return { x: 1, y: 1 };
	const x = image.width / screen.width;
	const y = image.height / screen.height;
	if (Math.abs(x - y) / Math.max(x, y) <= 0.02) return { x, y: x };
	return { x, y };
}

/** Ponto da imagem que o modelo viu → ponto da tela real, via fator por eixo. */
export function imagePointToScreen(
	point: { x: number; y: number },
	factor: ScreenshotFactor,
	screen?: { width: number; height: number } | null,
): { x: number; y: number } {
	const fx = factor.x > 0 && Number.isFinite(factor.x) ? factor.x : 1;
	const fy = factor.y > 0 && Number.isFinite(factor.y) ? factor.y : 1;
	const x = Math.round(point.x / fx);
	const y = Math.round(point.y / fy);
	if (!screen) return { x, y };
	return {
		x: Math.min(Math.max(0, x), Math.max(0, screen.width - 1)),
		y: Math.min(Math.max(0, y), Math.max(0, screen.height - 1)),
	};
}
