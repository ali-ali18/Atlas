import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { API_INPUT_LIMITS } from "../chat/input-limits.js";

const limit = bodyLimit({
	maxSize: API_INPUT_LIMITS.jsonBytes,
	onError: (c) => c.json({ error: "JSON body exceeds 1 MiB" }, 413),
});

/** Uploads têm seu próprio limite de 10 MiB + envelope multipart. */
export const jsonBodyLimit = createMiddleware(async (c, next) => {
	if (!/^(POST|PUT|PATCH)$/.test(c.req.method) ||
		c.req.path === "/v1/uploads/images" || c.req.path === "/v1/transcriptions" || c.req.path.startsWith("/v1/hooks/")) {
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
