import { captureLite } from "@workspace/shared"

/**
 * Observabilidade do servidor Next: erros de renderização/rotas vão ao Sentry só se SENTRY_DSN existir
 * (cliente mínimo por `fetch`, sem SDK no bundle). Segredos e dados pessoais são removidos antes.
 */
export async function register() {
  // nada a iniciar: o envio é por evento
}

export function onRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: { routePath?: string; routeType?: string },
) {
  captureLite({
    error,
    service: "web-server",
    env: process.env,
    url: request.path,
    tags: { method: request.method, route: context.routePath ?? "", routeType: context.routeType ?? "" },
  })
}
