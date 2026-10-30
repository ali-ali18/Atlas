import { mkdirSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { test, type Page } from "@playwright/test"
import { MockAtlas, type MockHandler } from "./mock-api"

/**
 * Prévias do avatar vivo no app (tema escuro; 1440 e 390): cabeçalho, sidebar e indicador de trabalho durante um run
 * simulado que passa por pensar, pesquisar, ler, programar, falhar uma ferramenta, escrever e terminar.
 * O stream do run vem de um servidor SSE local com tempo real (o mock da API entrega o corpo todo de uma vez, e
 * os estados do avatar dependem do tempo). Grava vídeo e salva capturas dos estados.
 * Só roda com AVATAR_PREVIEW_DIR (pasta de saída). AVATAR_PREVIEW_CHROMIUM aponta um Chromium já instalado (opcional).
 */
const OUT = process.env.AVATAR_PREVIEW_DIR
const CHROMIUM = process.env.AVATAR_PREVIEW_CHROMIUM ?? process.env.CHAT_CARDS_CHROMIUM_PATH
if (CHROMIUM) test.use({ launchOptions: { executablePath: CHROMIUM } })

const SIZES = [
  { name: "desktop-1440", viewport: { width: 1440, height: 900 }, mobile: false },
  { name: "mobile-390", viewport: { width: 390, height: 844 }, mobile: true },
] as const

type Step = { at: number; event: Record<string, unknown> }
const call = (id: string, name: string, step: number, args: Record<string, unknown>): Record<string, unknown> => ({ type: "tool_call", id, name, args: JSON.stringify(args), step, maxSteps: 8 })
const result = (id: string, name: string, ok: boolean, summary: string): Record<string, unknown> => ({ type: "tool_result", id, name, ok, summary })

/** Linha do tempo do run (ms desde o início do stream). */
const TIMELINE: Step[] = [
  { at: 0, event: { type: "run", runId: "run-avatar", status: "running" } },
  // Sem este evento o app segue em "na fila" (o avatar espera em órbita).
  { at: 300, event: { type: "status", status: "running" } },
  { at: 2000, event: call("t1", "navigate", 0, { url: "https://exemplo.com/precos" }) },
  { at: 4600, event: result("t1", "navigate", true, "Página aberta.") },
  { at: 4800, event: call("t2", "read_file", 1, { path: "in/vendas.csv" }) },
  { at: 7600, event: result("t2", "read_file", true, "Arquivo lido.") },
  { at: 7800, event: call("t3", "edit_file", 2, { path: "app/frete.ts" }) },
  { at: 10600, event: result("t3", "edit_file", true, "Arquivo editado.") },
  { at: 10800, event: call("t4", "shell", 3, { command: "pnpm test" }) },
  { at: 13000, event: result("t4", "shell", false, "Os testes falharam.") },
  { at: 15200, event: { type: "assistant_delta", id: "a1", delta: "Os testes falharam em um caso de frete. " } },
  { at: 16200, event: { type: "assistant_delta", id: "a1", delta: "Corrigi a regra do CEP e rodei de novo: " } },
  { at: 17200, event: { type: "assistant_delta", id: "a1", delta: "tudo passou." } },
  { at: 18200, event: { type: "done", message: { role: "assistant", content: "Os testes falharam em um caso de frete. Corrigi a regra do CEP e rodei de novo: tudo passou." }, model: "mock/e2e" } },
]

/** Servidor SSE local: entrega cada evento no seu horário. Aceita CORS com credenciais (o app o chama de outra origem). */
function startSse(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const origin = req.headers.origin ?? "*"
      const cors = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": req.headers["access-control-request-headers"] ?? "*", vary: "origin" }
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...cors, "access-control-allow-methods": "GET, OPTIONS" })
        res.end()
        return
      }
      console.log(`[avatar-preview] stream conectado (${new Date().toISOString()})`)
      res.writeHead(200, { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache" })
      const start = Date.now()
      TIMELINE.forEach((step, index) => {
        setTimeout(() => res.write(`id: ${index + 1}\ndata: ${JSON.stringify(step.event)}\n\n`), step.at)
      })
      setTimeout(() => res.end(), (TIMELINE.at(-1)?.at ?? 0) + 300)
      req.on("close", () => void start)
    })
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }))
  })
}

/** O mock base não conhece a lista de painéis da Biblioteca (devolve `{}`): lista vazia. */
const libraryHandler: MockHandler = ({ method, path }) =>
  method === "GET" && /^\/v1\/bots\/[^/]+\/pages$/.test(path)
    ? { body: { items: [] } }
    : method === "GET" && path === "/v1/usage"
      ? { body: { totals: { costUsd: 0, runs: 0, inputTokens: 0, outputTokens: 0 }, bots: [], models: [], days: [] } }
      : undefined

async function openChat(page: Page) {
  await page.goto("/")
  const bot = page.getByRole("button", { name: /Bot principal Atlas/ })
  try {
    await bot.waitFor({ timeout: 12_000 })
  } catch {
    await page.reload()
  }
  if ((await page.getByRole("textbox", { name: /Mensagem para/ }).count()) === 0) await bot.click()
  await page.getByRole("textbox", { name: /Mensagem para/ }).waitFor()
}

for (const size of SIZES) {
  test.describe(`avatar vivo no app (escuro, ${size.name})`, () => {
    test.skip(!OUT, "defina AVATAR_PREVIEW_DIR para gerar as capturas")

    test("run simulado", async ({ browser, baseURL }) => {
      test.setTimeout(180_000)
      // Contexto próprio: o vídeo (fixture) não aceita tamanho por grupo.
      const context = await browser.newContext({
        baseURL,
        locale: "pt-BR",
        deviceScaleFactor: size.mobile ? 2 : 1,
        viewport: size.viewport,
        isMobile: size.mobile,
        hasTouch: size.mobile,
        recordVideo: { dir: `${OUT}/video-${size.name}`, size: size.viewport },
      })
      await context.addInitScript(() => localStorage.setItem("theme", "dark"))
      const page = await context.newPage()
      const { server, port } = await startSse()
      try {
        const api = new MockAtlas({ botShape: process.env.AVATAR_PREVIEW_SHAPE ?? "cloud", botColor: "#FF6700", history: [{ role: "user", content: "Oi" }, { role: "assistant", content: "Oi! Como posso ajudar?" }] })
        api.handler = libraryHandler
        await api.install(context)
        // Registrada depois do mock: tem prioridade e leva o stream do run ao servidor com tempo real.
        await context.route(/\/v1\/runs\/[^/]+\/stream/, (route) => route.continue({ url: `http://127.0.0.1:${port}/stream` }))
        page.on("requestfailed", (r) => console.log(`[avatar-preview] falhou: ${r.url()} ${r.failure()?.errorText}`))
        page.on("console", (m) => (m.type() === "error" ? console.log(`[avatar-preview] console: ${m.text().slice(0, 200)}`) : undefined))
        await openChat(page)
        await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
        const box = page.getByRole("textbox", { name: /Mensagem para/ })
        await box.fill("Confere o frete, roda os testes e corrige o que falhar.")
        const send = page.getByRole("button", { name: /^(enviar|send)/i })
        if ((await send.count()) > 0) await send.first().click()
        else await box.press("Enter")
        const t0 = Date.now()
        // Gravação: o vídeo do Playwright depende de um ffmpeg que nem sempre existe; sem ele, uma sequência de
        // capturas com o horário de cada uma (o script de montagem junta num MP4 com o tempo real).
        const frames: Array<{ file: string; ts: number }> = []
        let recording = true
        const framesDir = `${OUT}/frames-${size.name}`
        mkdirSync(framesDir, { recursive: true })
        const loop = (async () => {
          while (recording) {
            const ts = Date.now() - t0
            const file = `${framesDir}/${String(frames.length).padStart(4, "0")}.jpg`
            await page.screenshot({ path: file, type: "jpeg", quality: 85 })
            frames.push({ file, ts })
            if (frames.length % 8 === 0) console.log(`[avatar-preview] ${size.name} t=${ts}ms rótulo="${(await page.getByTestId("working-line").first().textContent({ timeout: 200 }).catch(() => "-")) ?? "-"}"`)
          }
        })()
        await page.waitForTimeout(22_000)
        recording = false
        await loop
        writeFileSync(`${OUT}/frames-${size.name}.json`, JSON.stringify(frames))
        await context.close()
        await page.video()?.saveAs(`${OUT}/avatar-${size.name}.webm`).catch(() => undefined)
      } finally {
        server.close()
      }
    })
  })
}
