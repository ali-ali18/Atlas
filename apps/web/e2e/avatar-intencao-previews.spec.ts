import { mkdirSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { test, type Page } from "@playwright/test"
import { MockAtlas, type MockHandler } from "./mock-api"

/**
 * Prévia do `tool_intent` (tema escuro; 1440 e 390): o modelo leva ~10 s gerando um arquivo grande (write_file).
 * ANTES (sem o evento, como no 0.3.2) o avatar fica em "pensando" até o tool_call; DEPOIS já mostra a ação
 * (Programando) desde que o nome da ferramenta chega. O stream vem de um servidor SSE local com tempo real.
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
const VARIANTS = ["antes", "depois"] as const

function timeline(variant: (typeof VARIANTS)[number]): Step[] {
  const args = { path: "app/relatorio.ts", content: "…arquivo grande…" }
  return [
    { at: 0, event: { type: "run", runId: `run-${variant}`, status: "running" } },
    { at: 300, event: { type: "status", status: "running" } },
    // O nome da tool chega cedo (o modelo ainda gera ~10 s de argumentos). Sem o evento = servidor 0.3.2.
    ...(variant === "depois" ? [{ at: 1500, event: { type: "tool_intent", name: "write_file", callId: "t1" } }] : []),
    { at: 11500, event: { type: "tool_call", id: "t1", name: "write_file", args: JSON.stringify(args), step: 0, maxSteps: 8 } },
    { at: 13000, event: { type: "tool_result", id: "t1", name: "write_file", ok: true, summary: "Arquivo criado." } },
    { at: 15000, event: { type: "assistant_delta", id: "a1", delta: "Criei o relatório em app/relatorio.ts." } },
    { at: 16000, event: { type: "done", message: { role: "assistant", content: "Criei o relatório em app/relatorio.ts." }, model: "mock/e2e" } },
  ]
}

function startSse(steps: Step[]): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const origin = req.headers.origin ?? "*"
      const cors = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": req.headers["access-control-request-headers"] ?? "*", vary: "origin" }
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...cors, "access-control-allow-methods": "GET, OPTIONS" })
        res.end()
        return
      }
      res.writeHead(200, { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache" })
      steps.forEach((step, index) => setTimeout(() => res.write(`id: ${index + 1}\ndata: ${JSON.stringify(step.event)}\n\n`), step.at))
      setTimeout(() => res.end(), (steps.at(-1)?.at ?? 0) + 300)
    })
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }))
  })
}

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
    await bot.waitFor({ timeout: 20_000 })
  } catch {
    await page.reload()
  }
  if ((await page.getByRole("textbox", { name: /Mensagem para/ }).count()) === 0) await bot.click()
  await page.getByRole("textbox", { name: /Mensagem para/ }).waitFor()
}

for (const size of SIZES) {
  for (const variant of VARIANTS) {
    test.describe(`avatar: intenção da tool (${variant}, escuro, ${size.name})`, () => {
      test.skip(!OUT, "defina AVATAR_PREVIEW_DIR para gerar as capturas")

      test("run com arquivo grande", async ({ browser, baseURL }) => {
        test.setTimeout(120_000)
        const context = await browser.newContext({
          baseURL,
          locale: "pt-BR",
          deviceScaleFactor: size.mobile ? 2 : 1,
          viewport: size.viewport,
          isMobile: size.mobile,
          hasTouch: size.mobile,
          recordVideo: { dir: `${OUT}/video-${variant}-${size.name}`, size: size.viewport },
        })
        await context.addInitScript(() => localStorage.setItem("theme", "dark"))
        const page = await context.newPage()
        const { server, port } = await startSse(timeline(variant))
        try {
          const api = new MockAtlas({ botShape: "cloud", botColor: "#FF6700", history: [{ role: "user", content: "Oi" }, { role: "assistant", content: "Oi! Como posso ajudar?" }] })
          api.handler = libraryHandler
          await api.install(context)
          await context.route(/\/v1\/runs\/[^/]+\/stream/, (route) => route.continue({ url: `http://127.0.0.1:${port}/stream` }))
          await openChat(page)
          await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
          const box = page.getByRole("textbox", { name: /Mensagem para/ })
          await box.fill("Cria o relatório de vendas completo em app/relatorio.ts.")
          const send = page.getByRole("button", { name: /^(enviar|send)/i })
          if ((await send.count()) > 0) await send.first().click()
          else await box.press("Enter")
          const t0 = Date.now()
          const frames: Array<{ file: string; ts: number; label: string }> = []
          const dir = `${OUT}/frames-${variant}-${size.name}`
          mkdirSync(dir, { recursive: true })
          let recording = true
          const loop = (async () => {
            while (recording) {
              const ts = Date.now() - t0
              const file = `${dir}/${String(frames.length).padStart(4, "0")}.jpg`
              await page.screenshot({ path: file, type: "jpeg", quality: 85 })
              const label = ((await page.getByTestId("working-line").first().textContent({ timeout: 150 }).catch(() => "")) ?? "").trim()
              frames.push({ file, ts, label })
            }
          })()
          await page.waitForTimeout(16_500)
          recording = false
          await loop
          writeFileSync(`${OUT}/frames-${variant}-${size.name}.json`, JSON.stringify(frames))
          await context.close()
          await page.video()?.saveAs(`${OUT}/avatar-${variant}-${size.name}.webm`).catch(() => undefined)
        } finally {
          server.close()
        }
      })
    })
  }
}
