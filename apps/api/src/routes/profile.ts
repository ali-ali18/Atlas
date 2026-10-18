import { Hono } from "hono";
import sharp from "sharp";
import { updateUserProfile, type UserProfile } from "@workspace/db";
import {
	PROFILE_IMAGE_MAX_BYTES,
	PROFILE_IMAGE_SIZE,
	parseProfileImageDataUrl,
	validateProfileName,
} from "@workspace/shared";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

type UpdateProfile = (userId: string, patch: { name?: string; image?: string | null }) => Promise<UserProfile>;

/** Reduz para 256x256 WebP (tira metadados e qualquer conteúdo ativo); devolve o data URL ou `null` se a imagem for inválida. */
export async function normalizeProfileImage(bytes: Uint8Array): Promise<string | null> {
	try {
		const input = sharp(Buffer.from(bytes), { limitInputPixels: 24_000_000, failOn: "error" });
		const meta = await input.metadata();
		if (!meta.format || !["jpeg", "png", "webp"].includes(meta.format)) return null;
		for (const quality of [82, 70, 58, 46]) {
			const out = await sharp(Buffer.from(bytes), { limitInputPixels: 24_000_000 })
				.rotate()
				.resize(PROFILE_IMAGE_SIZE, PROFILE_IMAGE_SIZE, { fit: "cover", position: "centre" })
				.webp({ quality })
				.toBuffer();
			if (out.length <= PROFILE_IMAGE_MAX_BYTES) return `data:image/webp;base64,${out.toString("base64")}`;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Perfil do usuário logado: nome (1–60 caracteres) e foto (data URL pequeno no campo `image` do User).
 * O alvo é sempre o usuário da sessão; qualquer `id`/`userId`/`email` no corpo é ignorado.
 */
export function createProfileRoutes(deps: { updateProfile?: UpdateProfile } = {}) {
	const app = new Hono<AuthEnv>();
	const update = deps.updateProfile ?? updateUserProfile;

	async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
		try {
			const body = await c.req.json();
			return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	}

	app.patch("/v1/me", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const body = await readBody(c);
		if (!body) return c.json({ error: "Corpo inválido: esperado { name }" }, 400);
		const name = validateProfileName(body.name);
		if (!name.ok) return c.json({ error: name.error }, 400);
		return c.json(await update(userId, { name: name.name }));
	});

	app.put("/v1/me/image", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const body = await readBody(c);
		if (!body) return c.json({ error: "Corpo inválido: esperado { image }" }, 400);
		const parsed = parseProfileImageDataUrl(body.image);
		if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
		const image = await normalizeProfileImage(parsed.bytes);
		if (!image) return c.json({ error: "Imagem inválida ou não suportada." }, 415);
		return c.json(await update(userId, { image }));
	});

	app.delete("/v1/me/image", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		return c.json(await update(userId, { image: null }));
	});

	return app;
}
