import { readFileSync } from "node:fs"
import type { NextConfig } from "next"

/** Versão do projeto (package.json raiz), exposta ao navegador no build. Vazia se não achar. */
function rootVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string }
    return raw.version ?? ""
  } catch {
    return ""
  }
}

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_ATLAS_VERSION: rootVersion() },
  transpilePackages: ["@workspace/ui"],
  // pdf.js 6 usa APIs muito novas (Map#getOrInsertComputed, Promise.withResolvers,
  // Uint8Array#toBase64): em Chrome/Android um pouco antigo a prévia de PDF
  // derrubava a página inteira. O build "legacy" traz os polyfills.
  turbopack: {
    resolveAlias: {
      "pdfjs-dist": "pdfjs-dist/legacy/build/pdf.mjs",
      "pdfjs-dist/web/pdf_viewer.mjs": "pdfjs-dist/legacy/web/pdf_viewer.mjs",
    },
  },
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      "pdfjs-dist$": "pdfjs-dist/legacy/build/pdf.mjs",
      "pdfjs-dist/web/pdf_viewer.mjs$": "pdfjs-dist/legacy/web/pdf_viewer.mjs",
    }
    return config
  },
  output: "standalone",
  // Build com pouca RAM (VPS): o Dockerfile usa `next build --webpack`, que
  // com estas opções fica em ~0,9 GB de pico (Turbopack passa de 1,6 GB).
  // `NEXT_BUILD_CPUS=1` limita os workers do build só onde é definido.
  experimental: {
    webpackMemoryOptimizations: true,
    // Rewrite = proxy com prazo padrão de 30 s: ditado longo (upload + STT de até
    // 60 s + retry) estourava e voltava 500/502 só em produção. 130 s cobre o pior caso.
    proxyTimeout: 130_000,
    ...(process.env.NEXT_BUILD_CPUS ? { cpus: Number(process.env.NEXT_BUILD_CPUS) } : {}),
  },
  // SSE via rewrite (AUTH_PLAN §3.1, Fase 3 — verificado no Next 16):
  // - Rewrites são proxy reverso (ver `rewrites.md` em
  //   `node_modules/next/dist/docs/`): repassam o corpo em streaming
  //   (chunked, sem `Content-Length`) sem buffer próprio. Não há `base64`
  //   nem cache aqui — só `source`/`destination`.
  // - O handler da API já desliga buffering (`apps/api/src/routes/runs.ts`,
  //   `GET /v1/runs/:id/stream`): `Content-Type: text/event-stream`,
  //   `Cache-Control: no-cache, no-transform` (o `no-transform` impede que
  //   compressão/proxies intermediários transformem o stream),
  //   `Connection: keep-alive` e `X-Accel-Buffering: no`.
  // - `compress` global fica no padrão (gzip só p/ conteúdo renderizado e
  //   estáticos — ver `compress.md`): desligá-lo seria global e é
  //   desnecessário p/ SSE, que já opta por não-transformar. Sem
  //   `Content-Length` na resposta (ReadableStream), nada a ajustar aqui.
  //   Se algum deploy puser buffer na frente (Traefik/Dokploy), preferir o
  //   roteamento por caminho `/v1` direto à API em vez de mexer neste arquivo.
  // O service worker nunca fica em cache (atualiza na hora) e controla o site todo.
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ]
  },
  async rewrites() {
    const apiUrl = (process.env.ATLAS_API_INTERNAL_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "")
    return [
      { source: "/v1/:path*", destination: `${apiUrl}/v1/:path*` },
      { source: "/api/auth/:path*", destination: `${apiUrl}/api/auth/:path*` },
    ]
  },
}

export default nextConfig
