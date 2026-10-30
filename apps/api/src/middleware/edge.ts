import { cors } from "hono/cors";
import type { Hono } from "hono";
import { requireUser } from "./auth.js";
import { apiCompress } from "./compress.js";
import { jsonBodyLimit } from "./json-body-limit.js";
import { rateLimitByIp } from "./rate-limit.js";
import { basicResponseHeaders } from "../routes/previews.js";

/** Caminho da prévia no modo básico (`/v1/previews/<id>/p` e abaixo): tem CORS e cabeçalhos próprios (`basicResponseHeaders`). */
const BASIC_PREVIEW_PATH = /^\/v1\/previews\/[a-z0-9]{20,40}\/p(?:\/|$)/;

/**
 * Middleware de borda da API, na ordem em que valem: CORS global, compressão, limites por IP, `requireUser` e limite de corpo.
 * Fica numa função para o teste exercitar a ORDEM REAL (o `cors()` global responde `OPTIONS` sem chamar `next()`, então precisa
 * pular a prévia, senão o preflight de um `fetch` com JSON/POST sairia sem `Access-Control-Allow-Origin: *` nem o sandbox).
 */
export function registerEdgeMiddleware(app: Hono, options: { corsOrigins: string[] }): void {
	const globalCors = cors({
		origin: options.corsOrigins,
		allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
		allowHeaders: [
			"Content-Type",
			"Last-Event-ID",
			"Authorization",
			"X-Atlas-Hook-Secret",
			"X-Atlas-Idempotency-Key",
			"Idempotency-Key",
			"X-Request-Id",
		],
		exposeHeaders: ["X-Atlas-Run-Id", "X-Request-Id"],
	});
	// A prévia no modo básico vem de origem opaca (`Origin: null`) e tem a política dela: o CORS do Atlas não se aplica.
	app.use("/*", (c, next) => (BASIC_PREVIEW_PATH.test(c.req.path) ? next() : globalCors(c, next)));

	// gzip/deflate em JSON e texto (listas, conversas); SSE fica de fora (ver middleware/compress.ts).
	// O login (/api/auth/*) fica fora: redirects e cookies do Better Auth passam sem transformação.
	app.use("/v1/*", apiCompress());

	app.use("/v1/hooks/*", rateLimitByIp(60, 60_000));
	app.use("/v1/email/inbound/*", rateLimitByIp(120, 60_000));
	app.use("/v1/runs/:id/stream", rateLimitByIp(30, 60_000));
	app.use("/v1/chat/stream", rateLimitByIp(30, 60_000));
	app.use("/v1/events", rateLimitByIp(60, 60_000));
	app.use("/v1/internal/dev-jobs/*", rateLimitByIp(300, 60_000));
	app.use("/v1/avatars/*", rateLimitByIp(120, 60_000));
	app.use("/v1/public/*", rateLimitByIp(60, 60_000));
	// Prévia no modo básico: sem login do Atlas, então limite por IP (uma página carrega dezenas de arquivos; folga larga).
	app.use("/v1/previews/:id/p", basicResponseHeaders);
	app.use("/v1/previews/:id/p/*", basicResponseHeaders);
	app.use("/v1/previews/:id/p/*", rateLimitByIp(1200, 60_000));
	app.use("/v1/*", requireUser);
	app.use("/v1/*", jsonBodyLimit);
}
