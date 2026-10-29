import { test, type Page } from "@playwright/test"
import { MockAtlas, type MockHandler } from "./mock-api"

/**
 * Capturas (tema escuro; 1440x900 e 390x844) da interface em vários idiomas: login (por Accept-Language e
 * pelo seletor de idioma), conversa principal em en-US/es-ES e Configurações → Geral com o seletor aberto.
 * Só roda com I18N_PREVIEW_DIR (pasta de saída). I18N_PREVIEW_CHROMIUM_PATH aponta um Chromium já instalado (opcional).
 */
const OUT = process.env.I18N_PREVIEW_DIR
const CHROMIUM = process.env.I18N_PREVIEW_CHROMIUM_PATH ?? process.env.CHAT_CARDS_CHROMIUM_PATH
if (CHROMIUM) test.use({ launchOptions: { executablePath: CHROMIUM } })

const SIZES = [
  { name: "desktop-1440", viewport: { width: 1440, height: 900 }, mobile: false },
  { name: "mobile-390", viewport: { width: 390, height: 844 }, mobile: true },
] as const

const LOCALES = [
  { id: "pt-BR", button: "Português" },
  { id: "en-US", button: "English" },
  { id: "es-ES", button: "Español" },
] as const

type Seed = { id: string; role: string; content: string }
const card = (id: string, role: string, body: Record<string, unknown>): Seed => ({ id, role, content: JSON.stringify({ v: 1, kind: role, ...body }) })
const PLAN = { title: "Organizar o fechamento do mês", steps: [{ text: "Ler as notas fiscais do Bling", kind: "read" }, { text: "Gerar a planilha de conciliação", kind: "write" }, { text: "Perguntar o que fazer com divergências", kind: "ask" }], needs: ["Acesso ao Bling"], risks: "Nenhum dado é alterado antes da sua aprovação." }

const SEEDS: Seed[] = [
  { id: "c01", role: "user", content: "Cria uma rotina que me manda um resumo das vendas toda segunda às 8h." },
  { id: "c02", role: "assistant", content: "Combinado! Vou criar a rotina agora." },
  card("c03", "routine", { action: "created", title: "Resumo de vendas", routineId: "r-1", triggerType: "cron", detail: "Resumo de vendas · toda segunda às 08:00" }),
  card("c04", "task-list", { runId: "run-1", items: [{ content: "Ler as vendas do mês", status: "completed" }, { content: "Calcular receita", status: "in_progress" }, { content: "Montar o painel", status: "pending" }] }),
  card("c05", "code-run", { callId: "call-1", code: "print(1)", status: "ok", durationMs: 1240, output: "1" }),
  card("c06", "confirm", { confirmId: "cf-1", title: "Enviar o resumo para a Marina?", description: "Vou mandar um e-mail com o resumo.", status: "pending", confirmLabel: "Enviar", cancelLabel: "Agora não" }),
  card("c07", "compaction", { before: 84200, after: 9100, summary: "Resumo da conversa." }),
  card("c08", "questionnaire", { questionnaireId: "q-1", title: "Antes de montar o painel", status: "pending", items: [{ name: "periodo", prompt: "Qual período?", choices: [{ value: "semana", label: "Última semana" }, { value: "mes", label: "Último mês" }] }] }),
  card("c09", "confirm", { confirmId: "cf-4", title: "Plano", status: "pending", confirmLabel: "Aprovar plano", cancelLabel: "Cancelar", plan: PLAN }),
]

const baseHandler: MockHandler = ({ method, path }) =>
  method === "GET" && /^\/v1\/bots\/[^/]+\/pages$/.test(path)
    ? { body: { items: [] } }
    : method === "GET" && path === "/v1/reflection"
      ? { body: { settings: { enabled: true, time: "03:00" }, memory: { limit: 2200, used: 640 }, timezone: "America/Sao_Paulo", hasPrimary: true, active: false, last: null } }
      : method === "GET" && path.startsWith("/v1/transcriptions/models")
        ? { body: { provider: "openai", defaultModel: "whisper-1", models: [{ id: "whisper-1", name: "Whisper" }] } }
        : method === "GET" && path.startsWith("/v1/usage")
          ? { body: { totals: { costUsd: 1.37, promptTokens: 1000, completionTokens: 500, totalTokens: 1500, runs: 12 }, byBot: [], byModel: [], daily: [] } }
          : undefined

const hideDevOverlay = (page: Page) => page.addStyleTag({ content: "nextjs-portal{display:none!important}" })

/** Login sem sessão (o MockAtlas põe um cookie de sessão; aqui só as rotas de auth). */
async function installLoggedOut(context: import("@playwright/test").BrowserContext) {
  await context.route(/\/api\/auth\//, (route) => {
    const path = new URL(route.request().url()).pathname
    const body = path.endsWith("/providers") ? { github: true, google: true } : path.endsWith("/get-session") ? null : {}
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
  })
}

async function waitLogin(page: Page, path = "/login") {
  await page.goto(path)
  await page.locator("input[type=email]").waitFor({ timeout: 60_000 })
  await hideDevOverlay(page)
  await page.waitForTimeout(700)
}

async function openChat(page: Page) {
  await page.goto("/")
  const bot = page.getByRole("button", { name: /Atlas/ }).first()
  await bot.waitFor({ timeout: 60_000 })
  if (!(await page.locator("[data-message-id]").first().isVisible())) await bot.click()
}

for (const size of SIZES) {
  test.describe(`previews i18n (escuro, ${size.name})`, () => {
    test.skip(!OUT, "defina I18N_PREVIEW_DIR para gerar as capturas")
    test.use({ viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile, locale: "pt-BR" })
    test.beforeEach(async ({ context }) => {
      await context.addInitScript(() => localStorage.setItem("theme", "dark"))
    })

    for (const loc of LOCALES) {
      test(`login por Accept-Language ${loc.id}`, async ({ browser }) => {
        test.setTimeout(120_000)
        const context = await browser.newContext({ locale: loc.id, viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile, baseURL: test.info().project.use.baseURL })
        await context.addInitScript(() => localStorage.setItem("theme", "dark"))
        await installLoggedOut(context)
        const page = await context.newPage()
        await waitLogin(page)
        await page.screenshot({ path: `${OUT}/login-accept-${loc.id}-${size.name}.png` })
        await context.close()
      })
    }

    for (const loc of LOCALES) {
      test(`login pelo seletor ${loc.id}`, async ({ browser }) => {
        test.setTimeout(120_000)
        const context = await browser.newContext({ locale: "pt-BR", viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile, baseURL: test.info().project.use.baseURL })
        await context.addInitScript(() => localStorage.setItem("theme", "dark"))
        await installLoggedOut(context)
        const page = await context.newPage()
        await waitLogin(page)
        if (loc.id !== "pt-BR") {
          await page.getByRole("navigation").getByRole("button", { name: loc.button }).click()
          await page.waitForLoadState("load")
          await waitLogin(page)
        }
        await page.screenshot({ path: `${OUT}/login-switcher-${loc.id}-${size.name}.png` })
        await context.close()
      })
    }

    for (const loc of LOCALES.filter((l) => l.id !== "pt-BR")) {
      test(`conversa ${loc.id}`, async ({ browser }) => {
        test.setTimeout(240_000)
        const context = await browser.newContext({ locale: loc.id, viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile, baseURL: test.info().project.use.baseURL })
        await context.addInitScript(() => localStorage.setItem("theme", "dark"))
        const page = await context.newPage()
        const api = new MockAtlas({ history: [] })
        const base = Date.parse("2026-10-15T12:00:00.000Z")
        SEEDS.forEach((seed, index) => {
          api.messages.push({ id: seed.id, conversationId: "conv-e2e", role: seed.role, content: seed.content, createdAt: new Date(base + index * 1000).toISOString() })
        })
        api.handler = baseHandler
        await api.install(context)
        await openChat(page)
        await page.locator(`[data-message-id="c01"]`).waitFor({ timeout: 30_000 })
        await hideDevOverlay(page)
        await page.waitForTimeout(1500)
        await page.screenshot({ path: `${OUT}/chat-${loc.id}-${size.name}.png` })
        await page.locator(`[data-message-id="c03"]`).first().scrollIntoViewIfNeeded()
        await page.evaluate(() => document.querySelector(`[data-message-id="c01"]`)?.scrollIntoView({ block: "start" }))
        await page.waitForTimeout(600)
        await page.screenshot({ path: `${OUT}/chat-top-${loc.id}-${size.name}.png` })
        await context.close()
      })
    }

    test("configurações idioma da interface (pt-BR)", async ({ context, page }) => {
      test.setTimeout(240_000)
      const api = new MockAtlas({ history: [] })
      api.handler = baseHandler
      await api.install(context)
      await page.goto("/")
      await page.locator("body").waitFor()
      await page.waitForTimeout(2000)
      await page.goto("/?settings=geral")
      for (let attempt = 0; attempt < 3 && (await page.getByText("This page couldn’t load").count()) > 0; attempt++) {
        await page.reload()
        await page.waitForTimeout(1500)
      }
      const picker = page.locator("#settings-ui-language")
      if (size.mobile) await page.getByRole("button", { name: /^Geral/ }).or(page.getByRole("link", { name: /^Geral/ })).first().click({ timeout: 30_000 }).catch(() => {})
      await picker.waitFor({ timeout: 60_000 })
      await hideDevOverlay(page)
      await picker.scrollIntoViewIfNeeded()
      await picker.click()
      await page.waitForTimeout(800)
      await page.screenshot({ path: `${OUT}/settings-general-picker-pt-BR-${size.name}.png` })
    })
  })
}
