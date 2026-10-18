import {
	SCREENSHOT_JPEG_QUALITY,
	imagePointToScreen,
	readImageSize,
	screenshotFactorFromSize,
	screenshotScalePercent,
	sniffImageMime,
	type ScreenshotFactor,
} from "@workspace/shared";
import type { SandboxManager } from "@workspace/sandbox";

/**
 * Screenshot que vai ao MODELO: JPEG reduzido (1024 px de largura, q70).
 * O modelo clica nas coordenadas da imagem que viu. Guardamos por sessão o
 * fator REAL (tamanho dos bytes devolvidos / tela), não o pedido: uma imagem
 * de sandbox antiga ignora a escala e devolve PNG cheio.
 */
type ScreenshotManager = Pick<SandboxManager, "execScreenshot" | "execScreen">;

type Geometry = {
	factor: ScreenshotFactor;
	screen: { width: number; height: number } | null;
	/** Canto da imagem na tela real (0,0 salvo em screenshot com `region`). */
	origin: { x: number; y: number };
};

export type ScreenshotRequest = {
	/** Recorte nas coordenadas da última screenshot que o modelo viu. */
	region?: { x: number; y: number; width: number; height: number };
	marks?: boolean;
};

const MAX_TRACKED_SESSIONS = 200;
const geometryBySession = new Map<string, Geometry>();

function remember(sessionId: string, geometry: Geometry) {
	if (geometryBySession.size >= MAX_TRACKED_SESSIONS) {
		const oldest = geometryBySession.keys().next().value;
		if (oldest !== undefined) geometryBySession.delete(oldest);
	}
	geometryBySession.set(sessionId, geometry);
}

export async function captureModelScreenshot(
	manager: ScreenshotManager,
	sessionId: string,
	request: ScreenshotRequest = {},
): Promise<{ dataUrl: string; summary: string }> {
	// Geometria desconhecida → não reduz (escala 100), mas ainda comprime.
	const screen = await manager.execScreen(sessionId).catch(() => null);
	const region = request.region ? regionToScreen(sessionId, request.region, screen) : undefined;
	const percent = screen && !region ? screenshotScalePercent(screen.width) : 100;
	const buffer = await manager.execScreenshot(sessionId, {
		scalePercent: percent,
		jpegQuality: SCREENSHOT_JPEG_QUALITY,
		...(region ? { region } : {}),
		...(request.marks ? { marks: true } : {}),
	});
	const actual = readImageSize(buffer);
	const mime = sniffImageMime(buffer);
	const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
	// Sandbox antigo ignora `region` e devolve a tela toda: trata como inteira.
	const cropped =
		region && actual && !(screen && actual.width === screen.width && actual.height === screen.height);
	if (region && actual && cropped) {
		const factor = screenshotFactorFromSize(actual, { width: region.width, height: region.height });
		remember(sessionId, { factor, screen, origin: { x: region.x, y: region.y } });
		return {
			dataUrl,
			summary: `Zoom captured for model analysis (${actual.width}x${actual.height}; click coordinates refer to THIS crop; take a screenshot without a region to return to the full screen). The user has not received this image; use show_image to display it in the chat.${marksNote(request)}`,
		};
	}
	remember(sessionId, {
		factor: screenshotFactorFromSize(actual, screen),
		screen,
		origin: { x: 0, y: 0 },
	});
	const ignored = region ? " The VM ignored the crop (old image): the full screen was returned." : "";
	return { dataUrl, summary: `${describeShot(actual, screen)}${ignored}${marksNote(request)}` };
}

function marksNote(request: ScreenshotRequest): string {
	return request.marks
		? " Numbers over elements are browser_snapshot refs (e.g. 12 = e12)."
		: "";
}

/** Recorte pedido (coords da imagem do modelo) → retângulo na tela real. */
function regionToScreen(
	sessionId: string,
	region: NonNullable<ScreenshotRequest["region"]>,
	screen: { width: number; height: number } | null,
): { x: number; y: number; width: number; height: number } | undefined {
	if (!screen) return undefined;
	const a = modelPointToScreen(sessionId, region.x, region.y);
	const b = modelPointToScreen(sessionId, region.x + region.width, region.y + region.height);
	const x = Math.max(0, Math.min(a.x, screen.width - 1));
	const y = Math.max(0, Math.min(a.y, screen.height - 1));
	const width = Math.min(screen.width - x, Math.max(0, b.x - a.x));
	const height = Math.min(screen.height - y, Math.max(0, b.y - a.y));
	return width >= 8 && height >= 8 ? { x, y, width, height } : undefined;
}

function describeShot(
	actual: { width: number; height: number } | null,
	screen: { width: number; height: number } | null,
): string {
	if (!actual) {
		return "Screenshot captured for model analysis (image size not identified; coordinates treated as real screen coordinates). The user has not received this image; use show_image to display it in the chat.";
	}
	const note = screen
		? `; real screen ${screen.width}x${screen.height}`
		: "; real screen unknown";
	return `Screenshot captured for model analysis (${actual.width}x${actual.height}${note}; click/scroll coordinates refer to this image). The user has not received this image; use show_image to display it in the chat.`;
}

/** Coordenadas vistas pelo modelo → coordenadas reais da tela. */
export function modelPointToScreen(
	sessionId: string,
	x: number,
	y: number,
): { x: number; y: number } {
	const geometry = geometryBySession.get(sessionId);
	if (!geometry) return { x, y };
	const p = imagePointToScreen({ x, y }, geometry.factor);
	const px = p.x + geometry.origin.x;
	const py = p.y + geometry.origin.y;
	const screen = geometry.screen;
	if (!screen) return { x: px, y: py };
	return {
		x: Math.min(Math.max(0, px), Math.max(0, screen.width - 1)),
		y: Math.min(Math.max(0, py), Math.max(0, screen.height - 1)),
	};
}

/** Valida os args da tool `screenshot` (region com tamanho mínimo, marks booleano). */
export function parseScreenshotArgs(args: Record<string, unknown>): ScreenshotRequest {
	const request: ScreenshotRequest = {};
	if (args.marks === true) request.marks = true;
	const r = args.region;
	if (r && typeof r === "object") {
		const { x, y, width, height } = r as Record<string, unknown>;
		const [rx, ry, rw, rh] = [x, y, width, height].map(Number) as [number, number, number, number];
		const valid = [rx, ry, rw, rh].every(Number.isFinite) && rw >= 8 && rh >= 8 && rx >= 0 && ry >= 0;
		if (valid) request.region = { x: rx, y: ry, width: rw, height: rh };
	}
	return request;
}
