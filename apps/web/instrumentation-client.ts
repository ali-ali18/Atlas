import { captureLite } from "@workspace/shared"

/**
 * Erros não tratados do navegador vão ao Sentry só se NEXT_PUBLIC_SENTRY_DSN foi definido no build.
 * Sem DSN, não registra nada. A URL enviada não leva query nem fragmento.
 */
const env = {
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  ATLAS_COMMIT: process.env.NEXT_PUBLIC_ATLAS_COMMIT,
  NODE_ENV: process.env.NODE_ENV,
}

if (env.NEXT_PUBLIC_SENTRY_DSN) {
  const report = (error: unknown) =>
    captureLite({ error, service: "web-client", env, url: `${window.location.origin}${window.location.pathname}` })
  window.addEventListener("error", (event) => report(event.error ?? event.message))
  window.addEventListener("unhandledrejection", (event) => report(event.reason))
}
