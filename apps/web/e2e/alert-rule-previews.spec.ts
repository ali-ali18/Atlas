import { test, type Page } from "@playwright/test"
import { MockAtlas, type MockHandler } from "./mock-api"

/**
 * Capturas (tema escuro, desktop 1440 e celular 390) do cartão da rotina de alerta com regra (conferido pelo
 * servidor): regra, última leitura e frequência, ao lado de um alerta comum. Só roda com ALERT_RULE_PREVIEW_DIR.
 * ALERT_RULE_CHROMIUM_PATH aponta um Chromium já instalado (opcional).
 */
const OUT = process.env.ALERT_RULE_PREVIEW_DIR
const CHROMIUM = process.env.ALERT_RULE_CHROMIUM_PATH ?? process.env.CHAT_CARDS_CHROMIUM_PATH
if (CHROMIUM) test.use({ launchOptions: { executablePath: CHROMIUM } })

const SIZES = [
  { name: "desktop-1440", viewport: { width: 1440, height: 900 }, mobile: false },
  { name: "mobile-390", viewport: { width: 390, height: 844 }, mobile: true },
] as const

const BASE = { userId: "u-e2e", botId: "", conversationId: null, model: "openai/gpt-4o-mini", enabled: true, timezone: "America/Sao_Paulo", createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-10T12:00:00.000Z", lastRunAt: "2026-10-30T11:00:00.000Z" }
const page = (url: string, selector: string) => ({ type: "page", url, extract: { kind: "css", selector, attribute: "content" } })
const ROUTINES = [
  {
    ...BASE, id: "r-1", name: "Tênis Nike Pegasus", prompt: "Server-checked alert.", triggerType: "interval", schedule: null, interval: { everyMinutes: 120 },
    alert: {
      condition: "tênis Nike ficar abaixo de R$ 400,00", active: false,
      rule: { source: page("https://loja.example.com/tenis-pegasus", "span.price"), check: { kind: "value", parse: "money", op: "lt", value: 400 }, label: "tênis Nike" },
      ruleState: { lastValue: 449.9, lastReadAt: "2026-10-30T11:00:00.000Z", consecutive: 0 },
    },
  },
  {
    ...BASE, id: "r-2", name: "Dólar", prompt: "Server-checked alert.", triggerType: "cron", schedule: "0 10,14,17 * * 1-5",
    alert: {
      condition: "dólar passar de 6", active: true,
      rule: { source: { type: "page", url: "https://api.example.com/fx", extract: { kind: "jsonpath", path: "$.usd.brl" } }, check: { kind: "value", parse: "number", op: "gt", value: 6 }, label: "dólar" },
      ruleState: { lastValue: 6.12, lastReadAt: "2026-10-30T11:00:00.000Z", consecutive: 2 },
    },
  },
  {
    ...BASE, id: "r-3", name: "Editais da prefeitura", prompt: "Server-checked alert.", triggerType: "interval", schedule: null, interval: { everyMinutes: 60 },
    alert: {
      condition: "surgir um item novo em editais", active: false,
      rule: { source: { type: "feed", url: "https://prefeitura.example.com/editais.xml" }, check: { kind: "new_item" }, label: "editais" },
      ruleState: { seeded: true, seenIds: ["a", "b"], lastReadAt: "2026-10-30T11:00:00.000Z" },
    },
  },
  { ...BASE, id: "r-4", name: "Estoque da canela", prompt: "Watch the stock.", triggerType: "interval", schedule: null, interval: { everyMinutes: 180 }, alert: { condition: "o estoque da canela cair abaixo de 10", active: false } },
]

const handler: MockHandler = ({ method, path }) => {
  if (method === "GET" && /^\/v1\/bots\/[^/]+\/routines$/.test(path)) return { body: { routines: ROUTINES } }
  if (method === "GET" && /^\/v1\/bots\/[^/]+\/pages$/.test(path)) return { body: { items: [] } }
  if (method === "GET" && /^\/v1\/bots\/[^/]+\/artifacts/.test(path)) return { body: { files: [], nextCursor: null } }
  if (method === "GET" && path.startsWith("/v1/usage")) return { body: { totals: { costUsd: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, runs: 0 }, byBot: [], byModel: [], daily: [] } }
  return undefined
}

async function openRoutines(page: Page) {
  const toggle = page.locator('[aria-label="Abrir painel lateral"], [aria-label="Open side panel"]').first()
  if ((await toggle.count()) > 0) {
    await toggle.evaluate((el) => (el as HTMLElement).click())
    await page.waitForTimeout(800)
  }
  await page.getByRole("tab", { name: /^Biblioteca$/ }).click({ timeout: 15_000 }).catch(() => {})
  await page.getByText("Rotinas", { exact: true }).first().waitFor({ state: "visible", timeout: 30_000 })
  await page.getByText("Documentos", { exact: true }).first().click()
  await page.getByText("Rotinas", { exact: true }).first().click()
  await page.getByText("Tênis Nike Pegasus").first().waitFor({ timeout: 30_000 })
  await page.waitForTimeout(600)
}

for (const size of SIZES) {
  test.describe(`previews do alerta com regra (escuro, ${size.name})`, () => {
    test.skip(!OUT, "defina ALERT_RULE_PREVIEW_DIR para gerar as capturas")
    test("cartões das rotinas de alerta na Biblioteca", async ({ browser }) => {
      test.setTimeout(240_000)
      const context = await browser.newContext({ locale: "pt-BR", viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile, baseURL: test.info().project.use.baseURL })
      await context.addInitScript(() => localStorage.setItem("theme", "dark"))
      const tab = await context.newPage()
      const api = new MockAtlas({ history: [] })
      api.handler = handler
      await api.install(context)
      await tab.goto("/")
      const bot = tab.getByRole("button", { name: /Atlas/ }).first()
      await bot.waitFor({ timeout: 60_000 })
      if (!(await tab.locator("[data-message-id]").first().isVisible())) await bot.click()
      await tab.addStyleTag({ content: "nextjs-portal{display:none!important}" })
      await openRoutines(tab)
      await tab.screenshot({ path: `${OUT}/alert-rule-${size.name}.png` })
      await context.close()
    })
  })
}
