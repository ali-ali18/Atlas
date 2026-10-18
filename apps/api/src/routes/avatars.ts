import { Hono } from "hono";
import sharp from "sharp";
import { decodePushAvatarKey, renderPushAvatarScene, PUSH_AVATAR_SIZE } from "@workspace/shared";

/** Quantos PNGs ficam na memória (cada um tem poucos KB). */
export const AVATAR_CACHE_MAX = 200;
const CACHE_CONTROL = "public, max-age=31536000, immutable";

/** LRU mínimo (Map preserva a ordem de inserção: reinserir no acesso). */
export function createLru<V>(max: number) {
	const map = new Map<string, V>();
	return {
		get(key: string): V | undefined {
			const value = map.get(key);
			if (value === undefined) return undefined;
			map.delete(key);
			map.set(key, value);
			return value;
		},
		set(key: string, value: V) {
			map.delete(key);
			map.set(key, value);
			if (map.size > max) map.delete(map.keys().next().value as string);
		},
		get size() {
			return map.size;
		},
	};
}

export async function renderAvatarPng(key: string): Promise<Buffer | null> {
	const look = decodePushAvatarKey(key);
	if (!look) return null;
	return sharp(Buffer.from(renderPushAvatarScene(look)), { density: 72 })
		.resize(PUSH_AVATAR_SIZE, PUSH_AVATAR_SIZE)
		.png({ compressionLevel: 9 })
		.toBuffer();
}

/**
 * Ícone da notificação push: avatar do bot em PNG, público e sem sessão. A chave só tem forma + cor
 * (`pebble-0086ff-v1`), então não revela bot nem usuário e qualquer chave válida é imutável.
 */
export function createAvatarRoutes() {
	const app = new Hono();
	const cache = createLru<Buffer>(AVATAR_CACHE_MAX);

	app.get("/v1/avatars/:file", async (c) => {
		const file = c.req.param("file");
		if (!file.endsWith(".png")) return c.json({ error: "Not found" }, 404);
		const key = file.slice(0, -4);
		if (!decodePushAvatarKey(key)) return c.json({ error: "Invalid avatar key" }, 400);
		try {
			let png = cache.get(key);
			if (!png) {
				const rendered = await renderAvatarPng(key);
				if (!rendered) return c.json({ error: "Invalid avatar key" }, 400);
				png = rendered;
				cache.set(key, png);
			}
			return c.body(new Uint8Array(png), 200, { "Content-Type": "image/png", "Cache-Control": CACHE_CONTROL, "Content-Length": String(png.length) });
		} catch (error) {
			console.error("avatar render failed", error instanceof Error ? error.message : "erro");
			return c.json({ error: "Failed to render avatar" }, 500);
		}
	});

	return app;
}
