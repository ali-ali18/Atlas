import { createMiddleware } from "hono/factory";
import { newRequestId, runWithRequestId, sanitizeRequestId } from "@workspace/observability";

export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Request-id por requisição: reaproveita o `x-request-id` do cliente/proxy se for seguro, senão gera;
 * devolve no header da resposta e roda o resto da cadeia dentro do contexto (logs prefixados e id
 * levado ao worker nos jobs enfileirados).
 */
export const requestIdMiddleware = createMiddleware<{ Variables: { requestId: string } }>(async (c, next) => {
	const requestId = sanitizeRequestId(c.req.header(REQUEST_ID_HEADER)) ?? newRequestId();
	c.set("requestId", requestId);
	c.header(REQUEST_ID_HEADER, requestId);
	await runWithRequestId(requestId, next);
});
