import { test, type BrowserContext, type Page } from "@playwright/test"
import { MockAtlas, type MockHandler } from "./mock-api"

/**
 * Capturas (tema escuro, desktop 1440 e celular 390, escala 2) da seção "Agenda" da Biblioteca: lista de lembrete,
 * acompanhamento e espera por e-mail (3 blocos), pausado + encerrados (3 blocos), vazio e a confirmação de cancelar
 * (no desktop o botão aparece no hover; no celular, na pressão longa). Só roda com AGENDA_PREVIEW_DIR (pasta de saída).
 * AGENDA_CHROMIUM_PATH aponta um Chromium já instalado (opcional).
 */
const OUT = process.env.AGENDA_PREVIEW_DIR
const CHROMIUM = process.env.AGENDA_CHROMIUM_PATH ?? process.env.CHAT_CARDS_CHROMIUM_PATH
if (CHROMIUM) test.use({ launchOptions: { executablePath: CHROMIUM } })

const SIZES = [
  { name: "desktop-1440", viewport: { width: 1440, height: 900 }, mobile: false },
  { name: "mobile-390", viewport: { width: 390, height: 844 }, mobile: true },
] as const

const TZ = "America/Sao_Paulo"
const HOUR = 60 * 60 * 1000

/** Dia civil de hoje em São Paulo (AAAA, M, D), para montar "amanhã às 10:00" sem depender do relógio da máquina. */
function todayInSaoPaulo() {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).split("-").map(Number)
  return { y: y!, m: m!, d: d! }
}
/** `dia` a partir de hoje, `hora` no fuso de São Paulo (UTC-3). */
function at(dia: number, hora: number, minuto = 0) {
  const { y, m, d } = todayInSaoPaulo()
  return new Date(Date.UTC(y, m - 1, d + dia, hora + 3, minuto)).toISOString()
}
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString()

type View = Record<string, unknown>
const item = (patch: View): View => ({
  botId: "bot-e2e", kind: "remind", status: "pending", intervalMinutes: null, untilAt: null, event: null, endReason: null,
  runCount: 0, maxRuns: null, lastUpdate: null, createdAt: ago(30), nextAt: null, ...patch,
})

const ACTIVE = [
  item({ id: "a1", note: "Ligar para a Dra. Paula e confirmar a consulta", kind: "remind", nextAt: at(1, 10) }),
  item({
    id: "a2", note: "Preço da passagem para Lisboa em março", kind: "watch", intervalMinutes: 120, untilAt: at(13, 18), nextAt: at(0, 23, 30), runCount: 6,
    lastUpdate: { outcome: "update", at: ago(3), message: "Caiu para R$ 3.180 (era R$ 3.420) na TAP." },
  }),
  item({ id: "a3", note: "Avisar quando a nota fiscal do contador chegar", kind: "intent", untilAt: at(24, 12), event: { from: "contador@exemplo.com.br", hasAttachment: true } }),
]
const MIXED_ACTIVE = [
  item({ id: "p1", note: "Conferir se a fatura do cartão fechou", kind: "watch", status: "paused", intervalMinutes: 1440, nextAt: at(1, 9), lastUpdate: { outcome: "no_change", at: ago(26), message: null } }),
]
const ENDED = [
  item({ id: "e1", note: "Renovar o seguro do carro", status: "done", endReason: "completed", lastUpdate: { outcome: "done", at: ago(50), message: "Já te avisei: vence dia 20." } }),
  item({ id: "e2", note: "Acompanhar o edital da prefeitura", kind: "watch", status: "done", endReason: "ignored_notices", intervalMinutes: 240 }),
]

const library = (body: unknown): MockHandler => ({ method, path }) => {
  if (method === "GET" && /^\/v1\/bots\/[^/]+\/pages$/.test(path)) return { body: { items: [] } }
  if (method === "GET" && /^\/v1\/bots\/[^/]+\/artifacts/.test(path)) return { body: { files: [], nextCursor: null } }
  if (method === "GET" && path.startsWith("/v1/usage")) return { body: { totals: { costUsd: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, runs: 0 }, byBot: [], byModel: [], daily: [] } }
  if (method === "GET" && /^\/v1\/agenda/.test(path)) return { body }
  return undefined
}

async function openAgenda(context: BrowserContext, handler: MockHandler, size: (typeof SIZES)[number]) {
  const tab = await context.newPage()
  const api = new MockAtlas({ history: [] })
  api.handler = handler
  await api.install(context)
  await tab.goto("/")
  const bot = tab.getByRole("button", { name: /Atlas/ }).first()
  await bot.waitFor({ timeout: 60_000 })
  if (!(await tab.locator("[data-message-id]").first().isVisible())) await bot.click()
  await tab.addStyleTag({ content: "nextjs-portal{display:none!important}" })
  const toggle = tab.locator('[aria-label="Abrir painel lateral"], [aria-label="Open side panel"]').first()
  if ((await toggle.count()) > 0) {
    await toggle.evaluate((el) => (el as HTMLElement).click())
    await tab.waitForTimeout(800)
  }
  await tab.getByRole("tab", { name: /^Biblioteca$/ }).click({ timeout: 15_000 }).catch(() => {})
  const section = tab.locator('[data-library-section="agenda"]')
  await section.waitFor({ state: "visible", timeout: 30_000 })
  // Painéis fica aberto por padrão e roubaria a imagem: recolhe e abre só a Agenda.
  await tab.getByText("Painéis", { exact: true }).first().click().catch(() => {})
  await tab.waitForTimeout(500)
  void size
  return { tab, section }
}

async function newContext(browser: import("@playwright/test").Browser, size: (typeof SIZES)[number]) {
  const context = await browser.newContext({
    locale: "pt-BR", timezoneId: TZ, viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile, deviceScaleFactor: 2,
    baseURL: test.info().project.use.baseURL,
  })
  await context.addInitScript(() => {
    localStorage.setItem("theme", "dark")
    localStorage.setItem("atlas:library-section:agenda", "1")
    localStorage.setItem("atlas:library-section:pages", "0")
  })
  return context
}

for (const size of SIZES) {
  test.describe(`previews da Agenda (escuro, ${size.name})`, () => {
    test.skip(!OUT, "defina AGENDA_PREVIEW_DIR para gerar as capturas")

    test("lista: lembrete, acompanhamento com novidade e espera por e-mail", async ({ browser }) => {
      test.setTimeout(240_000)
      const context = await newContext(browser, size)
      const { tab, section } = await openAgenda(context, library({ enabled: true, timezone: TZ, items: ACTIVE, ended: [] }), size)
      await tab.getByText("Ligar para a Dra. Paula").first().waitFor()
      await tab.waitForTimeout(500)
      await section.screenshot({ path: `${OUT}/agenda-lista-${size.name}.png` })
      await context.close()
    })

    test("estados: pausado e encerrados com o motivo", async ({ browser }) => {
      test.setTimeout(240_000)
      const context = await newContext(browser, size)
      const { tab, section } = await openAgenda(context, library({ enabled: true, timezone: TZ, items: MIXED_ACTIVE, ended: ENDED }), size)
      await tab.getByText("Encerrados (2)").click()
      await tab.getByText("Acompanhar o edital da prefeitura").first().waitFor()
      await tab.waitForTimeout(500)
      await section.screenshot({ path: `${OUT}/agenda-estados-${size.name}.png` })
      await context.close()
    })

    test("vazio", async ({ browser }) => {
      test.setTimeout(240_000)
      const context = await newContext(browser, size)
      const { tab, section } = await openAgenda(context, library({ enabled: true, timezone: TZ, items: [], ended: [] }), size)
      await tab.getByText("Nada na agenda").first().waitFor()
      await section.screenshot({ path: `${OUT}/agenda-vazio-${size.name}.png` })
      await context.close()
    })

    test("cancelar: botão no hover (desktop) ou na pressão longa (celular) e a confirmação", async ({ browser }) => {
      test.setTimeout(240_000)
      const context = await newContext(browser, size)
      const { tab, section } = await openAgenda(context, library({ enabled: true, timezone: TZ, items: ACTIVE.slice(0, 1), ended: [] }), size)
      const card = tab.locator('[data-agenda-card="a1"]')
      await card.waitFor()
      const trash = tab.getByRole("button", { name: /^Cancelar: Ligar para a Dra\. Paula/ })
      if (size.mobile) {
        // Sem pressão longa o botão fica escondido.
        await section.screenshot({ path: `${OUT}/agenda-cancelar-antes-${size.name}.png` })
        await card.dispatchEvent("pointerdown", { pointerType: "touch", clientX: 100, clientY: 400 })
        await tab.waitForTimeout(700)
      } else {
        await section.screenshot({ path: `${OUT}/agenda-cancelar-antes-${size.name}.png` })
        await card.hover()
        await tab.waitForTimeout(300)
      }
      await section.screenshot({ path: `${OUT}/agenda-cancelar-botao-${size.name}.png` })
      await trash.click()
      await tab.getByText("Cancelar este combinado?").waitFor()
      await tab.waitForTimeout(500)
      await section.screenshot({ path: `${OUT}/agenda-cancelar-confirmacao-${size.name}.png` })
      await context.close()
    })
  })
}
