import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, test, type Page } from "@playwright/test"
import { LANDING_LOCK_MS } from "../lib/thread-position"
import { MockAtlas } from "./mock-api"

/**
 * Rolagem durante o stream: quem sobe a conversa para ler enquanto o bot escreve fica onde parou (nada puxa
 * para baixo, nem no fim do run); quem volta ao fim sozinho volta a acompanhar.
 *
 * O MockAtlas entrega o SSE de uma vez (`route.fulfill`), então aqui o stream do run passa por um servidor
 * HTTP de verdade, aberto pelo próprio teste, que manda os deltas aos poucos.
 */

const CHROMIUM = process.env.E2E_CHROMIUM
if (CHROMIUM) test.use({ launchOptions: { executablePath: CHROMIUM } })

const SENTINEL = "Fim da análise de outubro."
const PARTS = 500
const INTERVAL_MS = 40
/** O segundo run escreve mais devagar: gestos de dedo com a página ocupada demoram, e o stream não pode acabar antes. */
const SECOND_RUN_INTERVAL_MS = 80

function streamText(): string {
  const blocks = ["## Análise completa de outubro\n\nVou detalhar loja por loja e depois os canais."]
  for (const loja of ["Centro", "Norte", "Sul", "Leste", "Oeste", "Online", "Atacado"]) {
    blocks.push(
      `### Loja ${loja}\n\nA loja ${loja} fechou o mês com receita estável e ticket médio parecido com setembro. Pontos de atenção:\n\n- estoque de inverno abaixo do mínimo em 3 categorias;\n- conversão do provador caiu de 31% para 27%;\n- tempo médio de fila no caixa subiu para 4 min.\n\nA recomendação é reforçar a equipe aos sábados e antecipar a reposição.`,
    )
  }
  blocks.push(`Resumo: o mês foi bom no total. ${SENTINEL}`)
  return blocks.join("\n\n")
}

function history(count: number) {
  const out: Array<{ role: "user" | "assistant"; content: string }> = []
  for (let i = 0; out.length < count; i++) {
    out.push({ role: "user", content: `Pergunta antiga número ${i + 1} sobre as vendas` })
    out.push({
      role: "assistant",
      content: `Resposta antiga ${i + 1}.\n\nAs vendas somaram **R$ ${40 + i}.230,00**.\n\n- Centro: R$ 15.400,00\n- Norte: R$ 11.020,00\n- Sul: R$ 9.880,00`,
    })
  }
  return out
}

/** Servidor SSE real para `GET /v1/runs/:id/stream`: um delta a cada INTERVAL_MS. */
function startStreamServer(baseText: string): Promise<{ server: Server; port: number; finished: () => number }> {
  let done = 0
  const size = Math.ceil(baseText.length / PARTS)
  const server = createServer(async (req, res) => {
    const match = new URL(req.url ?? "/", "http://x").pathname.match(/^\/v1\/runs\/([^/]+)\/stream$/)
    if (!match) {
      res.writeHead(404).end()
      return
    }
    const runId = match[1]
    // O chat esconde a repetição exata da resposta anterior: do segundo run em diante o texto muda no começo.
    const text = runId === "run-1" ? baseText : baseText.replace("## Análise completa de outubro", "## Segunda leitura de outubro")
    const interval = runId === "run-1" ? INTERVAL_MS : SECOND_RUN_INTERVAL_MS
    const deltas: string[] = []
    for (let i = 0; i < text.length; i += size) deltas.push(text.slice(i, i + size))
    const events = [
      { type: "run", runId, status: "running" },
      ...deltas.map((delta) => ({ type: "assistant_delta", id: `a-${runId}`, delta })),
      { type: "done", message: { role: "assistant", content: text }, model: "mock/e2e" },
    ]
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "access-control-allow-origin": "*" })
    res.flushHeaders()
    let closed = false
    req.on("close", () => (closed = true))
    const after = Number(new URL(req.url ?? "/", "http://x").searchParams.get("after") ?? 0) || 0
    for (let i = after; i < events.length && !closed; i++) {
      res.write(`id: ${i + 1}\ndata: ${JSON.stringify(events[i])}\n\n`)
      if (events[i]?.type === "assistant_delta") await new Promise((resolve) => setTimeout(resolve, interval))
    }
    if (!closed) {
      done += 1
      res.end()
    }
  })
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, finished: () => done })),
  )
}

const SCROLLER = '[data-testid="chat-scroll"]'

async function metrics(page: Page) {
  return page.locator(SCROLLER).evaluate((element) => ({
    top: element.scrollTop,
    height: element.scrollHeight,
    distance: element.scrollHeight - element.scrollTop - element.clientHeight,
  }))
}

/** Grava scrollTop/scrollHeight a cada quadro até `stopSampling`. */
async function startSampling(page: Page) {
  await page.locator(SCROLLER).evaluate((element) => {
    const w = window as unknown as { __samples: Array<{ top: number; height: number; distance: number }>; __sampling: boolean }
    w.__samples = []
    w.__sampling = true
    const tick = () => {
      w.__samples.push({ top: element.scrollTop, height: element.scrollHeight, distance: element.scrollHeight - element.scrollTop - element.clientHeight })
      if (w.__sampling) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function stopSampling(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __samples: Array<{ top: number; height: number; distance: number }>; __sampling: boolean }
    w.__sampling = false
    return w.__samples
  })
}

/** Espera a posição de leitura assentar: scrollTop igual por vários quadros seguidos (no lugar de pausas fixas). Só para quem não está acompanhando o fim. */
async function settled(page: Page) {
  await expect
    .poll(
      () =>
        page.locator(SCROLLER).evaluate(
          (element) =>
            new Promise<boolean>((resolve) => {
              const read = () => element.scrollTop
              const first = read()
              let frames = 0
              const tick = () => (++frames < 8 ? requestAnimationFrame(tick) : resolve(read() === first))
              requestAnimationFrame(tick)
            }),
        ),
      { timeout: 20_000 },
    )
    .toBe(true)
}

type ScrollBy = (page: Page, deltaY: number) => Promise<void>

/** Desktop: roda do mouse em cima da conversa. */
const wheel: ScrollBy = async (page, deltaY) => {
  const box = await page.locator(SCROLLER).boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 3)
  await page.mouse.wheel(0, deltaY)
}

/** Celular: arrasto de dedo de verdade (toques enviados pelo CDP: touchStart, vários touchMove, touchEnd). */
const touch: ScrollBy = async (page, deltaY) => {
  const box = await page.locator(SCROLLER).boundingBox()
  const cdp = await page.context().newCDPSession(page)
  const x = Math.round(box!.x + box!.width / 2)
  // deltaY < 0 = rolar para cima = o dedo desce; deltaY > 0 = o dedo sobe. Cada gesto cobre no máximo metade da área.
  const reach = Math.floor(box!.height * 0.5)
  let remaining = Math.abs(deltaY)
  while (remaining > 0) {
    const step = Math.min(remaining, reach)
    remaining -= step
    const fromY = Math.round(box!.y + box!.height * (deltaY < 0 ? 0.25 : 0.75))
    const toY = deltaY < 0 ? fromY + step : fromY - step
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: fromY }] })
    const moves = 8
    for (let i = 1; i <= moves; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: Math.round(fromY + ((toY - fromY) * i) / moves) }] })
      await page.waitForTimeout(10)
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await page.waitForTimeout(100)
  }
  await cdp.detach()
}

async function openChat(page: Page) {
  await page.goto("/")
  const box = page.getByRole("textbox", { name: /Mensagem para/ })
  // Desktop já abre a conversa do bot principal; no celular é preciso tocar no bot.
  if (!(await box.isVisible().catch(() => false))) {
    const bot = page.getByRole("button", { name: /Bot principal Atlas/ })
    if (await bot.first().isVisible({ timeout: 8_000 }).catch(() => false)) await bot.first().click()
  }
  await expect(box).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText("Resposta antiga 30.").first()).toBeVisible({ timeout: 20_000 })
  // pouso no fim + trava de re-ancoragem (LANDING_LOCK_MS) assentam
  await page.waitForTimeout(LANDING_LOCK_MS + 500)
}

async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: /Mensagem para/ }).fill(text)
  await page.getByRole("button", { name: "Enviar mensagem" }).click()
}

async function setup(context: import("@playwright/test").BrowserContext, port: number) {
  const reply = streamText()
  // a resposta fica gravada no "servidor" quando o stream termina (mesmo tempo do stream real)
  const api = new MockAtlas({ reply, history: history(60), replyDelayMs: PARTS * SECOND_RUN_INTERVAL_MS + 400 })
  // Endpoints que só o desktop (painel lateral) chama.
  api.handler = ({ method, path }) => {
    if (method !== "GET") return undefined
    if (/\/routine-groups$/.test(path)) return { body: { groups: [] } }
    if (/^\/v1\/bots\/[^/]+\/pages$/.test(path)) return { body: { items: [] } }
    if (path === "/v1/providers") return { body: { providers: [] } }
    if (path === "/v1/provider-keys") return { body: { providers: [], vaultReady: true } }
    if (path === "/v1/dev-environments") return { body: { environments: [], secretsAvailable: false } }
    if (path === "/v1/transcriptions/status") return { body: { available: false } }
    if (path === "/v1/sandbox/sessions") return { body: { session: null } }
    return undefined
  }
  await api.install(context)
  // Registrada depois do MockAtlas = tem precedência: o stream do run vem do servidor SSE do teste, aos poucos.
  await context.route(/\/v1\/runs\/[^/]+\/stream/, (route) => {
    const url = new URL(route.request().url())
    return route.continue({ url: `http://127.0.0.1:${port}${url.pathname}${url.search}` })
  })
  return api
}

async function waitStreamEnd(finished: () => number, count: number) {
  await expect.poll(finished, { timeout: PARTS * SECOND_RUN_INTERVAL_MS + 20_000 }).toBeGreaterThanOrEqual(count)
}

const VIEWPORTS = [
  { name: "desktop", use: { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 }, scroll: wheel },
  { name: "celular", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, scroll: touch },
] as const

for (const size of VIEWPORTS) {
  test.describe(size.name, () => {
    test.use(size.use)

    test("subiu a conversa durante o stream: fica onde parou; voltou ao fim: acompanha de novo", async ({ context, page }) => {
      test.setTimeout(180_000)
      const { server, port, finished } = await startStreamServer(streamText())
      try {
        await setup(context, port)
        await openChat(page)
        expect((await metrics(page)).distance, "abre no fim da conversa").toBeLessThan(4)

        // 1) Enviar puxa para o fim; durante o stream a pessoa sobe ~300px e lá fica até o run terminar.
        await send(page, "Faz a análise completa de outubro")
        await expect(page.getByText("Análise completa de outubro").first()).toBeVisible({ timeout: 15_000 })
        await expect.poll(async () => (await metrics(page)).distance, { timeout: 10_000 }).toBeLessThan(4)
        await size.scroll(page, -300)
        await settled(page)
        const left = await metrics(page)
        expect(left.distance, "subiu de fato").toBeGreaterThan(150)
        await startSampling(page)
        await waitStreamEnd(finished, 1)
        // fim do run: o layout assenta e a conferência de fim de run roda
        await settled(page)
        const held = await stopSampling(page)
        const moved = held.filter((sample) => Math.abs(sample.top - left.top) > 2)
        expect(moved, `scrollTop deveria ficar em ${left.top}; mudou para ${[...new Set(moved.map((s) => Math.round(s.top)))].slice(0, 8).join(", ")}`).toHaveLength(0)
        expect(held.at(-1)!.height, "o conteúdo cresceu abaixo enquanto a pessoa lia").toBeGreaterThan(left.height)
        await expect(page.getByTestId("scroll-to-bottom")).toHaveCSS("opacity", "1")

        // 2) Novo stream: sobe, fica parado; volta ao fim rolando sozinho -> acompanha até o fim.
        await send(page, "De novo, por favor")
        await expect.poll(async () => (await metrics(page)).distance, { timeout: 10_000 }).toBeLessThan(4)
        await size.scroll(page, -300)
        await settled(page)
        const up = await metrics(page)
        expect(up.distance).toBeGreaterThan(150)
        await page.waitForTimeout(800)
        expect(Math.abs((await metrics(page)).top - up.top), "parado enquanto lê").toBeLessThanOrEqual(2)
        // volta ao fim "com a mão" (no celular, um gesto não cobre tudo; para sozinho ao chegar, o resto é o acompanhar)
        for (let i = 0; i < 10 && (await metrics(page)).distance > 8; i++) await size.scroll(page, Math.min((await metrics(page)).distance + 400, 1200))
        await startSampling(page)
        await page.waitForTimeout(1200)
        const following = await stopSampling(page)
        expect(following.at(-1)!.height, "ainda está chegando texto").toBeGreaterThan(following[0]!.height)
        // a cada token o texto cresce e a rolagem o alcança no mesmo quadro: quase todas as amostras ficam coladas no fim
        const glued = following.filter((sample) => sample.distance < 40).length / following.length
        expect(glued, "acompanha o fim de novo").toBeGreaterThan(0.8)
        await waitStreamEnd(finished, 2)
        await expect.poll(async () => (await metrics(page)).distance, { message: "terminou no fim", timeout: 10_000 }).toBeLessThan(4)
        await expect(page.getByText(SENTINEL).last()).toBeInViewport()
      } finally {
        server.close()
      }
    })
  })
}
