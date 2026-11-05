import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { API_INPUT_LIMITS } from "../chat/input-limits.js";

const limit = bodyLimit({
	maxSize: API_INPUT_LIMITS.jsonBytes,
	onError: (c) => c.json({ error: "JSON body exceeds 1 MiB" }, 413),
});

/**
 * Caminhos exatos com limite próprio, fora do teto de 1 MiB de JSON: imagem (10 MiB), anexo de arquivo (20 MiB,
 * ambos + envelope multipart, checados na rota) e transcrição. Rota nova aqui precisa impor o seu teto.
 */
const OWN_LIMIT_PATHS = new Set(["/v1/uploads/images", "/v1/uploads/files", "/v1/transcriptions"]);

/** Webhooks (`/v1/hooks/*`) e as rotas de `OWN_LIMIT_PATHS` têm limite próprio. */
export const jsonBodyLimit = createMiddleware(async (c, next) => {
	if (!/^(POST|PUT|PATCH)$/.test(c.req.method) ||
		OWN_LIMIT_PATHS.has(c.req.path) || c.req.path.startsWith("/v1/hooks/")) {
		await next();
		return;
	}
	const declared = Number(c.req.header("Content-Length"));
	if (Number.isFinite(declared) && declared > API_INPUT_LIMITS.jsonBytes) {
		return c.json({ error: "JSON body exceeds 1 MiB" }, 413);
	}
	// Hono pode confiar apenas em Content-Length. Contar o stream também evita
	// bypass com tamanho declarado menor em requests/adaptadores não validados.
	if (c.req.raw.headers.has("content-length")) {
		const headers = new Headers(c.req.raw.headers);
		headers.delete("content-length");
		c.req.raw = new Request(c.req.raw, { headers });
	}
	return limit(c, next);
});
