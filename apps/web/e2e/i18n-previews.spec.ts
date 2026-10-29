import { test, type Page } from "@playwright/test"
import { MockAtlas, type MockHandler } from "./mock-api"
import { catalogHandler } from "./marketplace-fixtures"

/**
 * Capturas (tema escuro; 1440x900 e 390x844) da interface em vários idiomas: login (por Accept-Language e
 * pelo seletor de idioma), conversa principal em en-US/es-ES, Configurações → Geral com o seletor aberto,
 * painel lateral da Biblioteca, Configurações (seção traduzida + busca em inglês) e o catálogo do Marketplace.
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

const VAULT_ITEMS = [
  { id: "v1", kind: "login", name: "bling_login", label: "Bling", description: "Acesso ao Bling", siteUrl: "https://bling.com.br", domain: "bling.com.br", username: "ana@example.com", createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-10T12:00:00.000Z", lastUsedAt: "2026-10-14T11:00:00.000Z", alwaysBots: [] },
]

const baseHandler: MockHandler = ({ method, path }) =>
  method === "GET" && path === "/v1/vault"
    ? { body: { items: VAULT_ITEMS, available: true } }
    : method === "GET" && /^\/v1\/bots\/[^/]+\/pages$/.test(path)
    ? { body: { items: [] } }
    : method === "GET" && path === "/v1/reflection"
      ? { body: { settings: { enabled: true, time: "03:00" }, memory: { limit: 2200, used: 640 }, timezone: "America/Sao_Paulo", hasPrimary: true, active: false, last: null } }
      : method === "GET" && path.startsWith("/v1/transcriptions/models")
        ? { body: { provider: "openai", defaultModel: "whisper-1", models: [{ id: "whisper-1", name: "Whisper" }] } }
        : method === "GET" && path.startsWith("/v1/usage")
          ? { body: { totals: { costUsd: 1.37, promptTokens: 1000, completionTokens: 500, totalTokens: 1500, runs: 12 }, byBot: [], byModel: [], daily: [] } }
          : undefined


const ROUTINE_BASE = { userId: "u-e2e", botId: "", conversationId: null, model: "openai/gpt-4o-mini", enabled: true, triggerType: "cron", timezone: "America/Sao_Paulo", createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-10T12:00:00.000Z", lastRunAt: "2026-10-14T11:00:00.000Z" }
const ROUTINES = [
  { ...ROUTINE_BASE, id: "r-1", name: "Resumo de vendas", prompt: "Send me a sales summary.", schedule: "0 8 * * 1" },
  { ...ROUTINE_BASE, id: "r-2", name: "Conferir pedidos atrasados", prompt: "Check late orders.", schedule: "0 9 * * 1-5" },
  { ...ROUTINE_BASE, id: "r-3", name: "Estoque da canela", prompt: "Watch the stock.", triggerType: "interval", schedule: null, interval: { everyMinutes: 180 }, alert: { condition: "o estoque da canela cair abaixo de 10", active: false } },
]
const PAGES = [{ id: "p-1", botId: "", title: "Vendas da semana", summary: "Receita, pedidos e ticket médio.", revision: 3, sourceCount: 2, updatedAt: "2026-10-14T12:00:00.000Z", refreshedAt: "2026-10-14T12:00:00.000Z" }]
const FILE_SEEDS: Seed[] = [
  card("f1", "file", { artifactId: "art-1", filename: "conciliacao-outubro.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 48213, format: "xlsx", version: 2 }),
  card("f2", "file", { artifactId: "art-2", filename: "contrato-fornecedor.pdf", mime: "application/pdf", size: 912340, format: "pdf", version: 1 }),
]
const FILES = [
  { id: "art-1", filename: "conciliacao-outubro.xlsx", size: 48213, version: 2, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", createdAt: "2026-10-14T12:00:00.000Z" },
  { id: "art-2", filename: "contrato-fornecedor.pdf", size: 912340, version: 1, mime: "application/pdf", createdAt: "2026-10-13T12:00:00.000Z" },
]
const libraryHandler: MockHandler = (request) => {
  const { method, path } = request
  if (method === "GET" && /^\/v1\/bots\/[^/]+\/routines$/.test(path)) return { body: { routines: ROUTINES } }
  if (method === "GET" && /^\/v1\/bots\/[^/]+\/pages$/.test(path)) return { body: { items: PAGES } }
  if (method === "GET" && /^\/v1\/bots\/[^/]+\/artifacts/.test(path)) return { body: { files: FILES, nextCursor: null } }
  return baseHandler(request)
}

/** Abre o painel lateral (Biblioteca), expande Documentos e Rotinas e espera as seções. */
async function openLibrary(page: Page, labels: { library: RegExp; routines: string; documents: string }) {
  const toggle = page.locator('[aria-label="Open side panel"], [aria-label="Abrir panel lateral"]').first()
  if ((await toggle.count()) > 0) {
    await toggle.evaluate((el) => (el as HTMLElement).click())
    await page.waitForTimeout(800)
  }
  await page.getByRole("tab", { name: labels.library }).click({ timeout: 15_000 }).catch(() => {})
  await page.getByText(labels.routines, { exact: true }).first().waitFor({ state: "visible", timeout: 30_000 })
  await page.getByText(labels.documents, { exact: true }).first().click()
  await page.getByText(labels.routines, { exact: true }).first().click()
  await page.waitForTimeout(600)
}

const SETTINGS_BY_LOCALE = {
  "en-US": { query: "execution", exec: /^Execution/, search: "vault" },
  "es-ES": { query: "execution", exec: /^Ejecución/, search: "vault" },
} as const

const LIBRARY_LABELS = {
  "en-US": { library: /^Library$/, routines: "Routines", documents: "Documents" },
  "es-ES": { library: /^Biblioteca$/, routines: "Rutinas", documents: "Documentos" },
} as const

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

    for (const loc of LOCALES.filter((l) => l.id !== "pt-BR")) {
      const id = loc.id as "en-US" | "es-ES"
      test(`biblioteca (painel lateral) ${id}`, async ({ browser }) => {
        test.setTimeout(240_000)
        const context = await browser.newContext({ locale: id, viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile, baseURL: test.info().project.use.baseURL })
        await context.addInitScript(() => localStorage.setItem("theme", "dark"))
        const page = await context.newPage()
        const api = new MockAtlas({ history: [] })
        const base = Date.parse("2026-10-15T12:00:00.000Z")
        FILE_SEEDS.forEach((seed, index) => {
          api.messages.push({ id: seed.id, conversationId: "conv-e2e", role: seed.role, content: seed.content, createdAt: new Date(base + index * 1000).toISOString() })
        })
        api.handler = libraryHandler
        await api.install(context)
        await openChat(page)
        await hideDevOverlay(page)
        await openLibrary(page, LIBRARY_LABELS[id])
        await page.waitForTimeout(1500)
        await page.screenshot({ path: `${OUT}/library-${id}-${size.name}.png` })
        await context.close()
      })

      test(`configurações (seção + busca) ${id}`, async ({ browser }) => {
        test.setTimeout(300_000)
        const context = await browser.newContext({ locale: id, viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile, baseURL: test.info().project.use.baseURL })
        await context.addInitScript(() => localStorage.setItem("theme", "dark"))
        const page = await context.newPage()
        const api = new MockAtlas({ history: [] })
        api.handler = baseHandler
        await api.install(context)
        await page.goto("/")
        await page.locator("body").waitFor()
        await page.waitForTimeout(2000)
        for (const [section, shot] of [["execucao", "settings-exec"], ["cofre", "settings-vault"]] as const) {
          await page.goto(`/?settings=${section}`)
          // O `next dev` às vezes derruba a página na 1ª carga: espera e recarrega (até 4 vezes).
          for (let attempt = 0; attempt < 4; attempt++) {
            await page.waitForTimeout(2500)
            if ((await page.getByText("This page couldn’t load").count()) === 0) break
            await page.reload()
          }
          await hideDevOverlay(page)
          await page.screenshot({ path: `${OUT}/${shot}-${id}-${size.name}.png` })
        }
        await page.goto("/?settings=geral")
        await page.waitForTimeout(2500)
        await hideDevOverlay(page)
        if (size.mobile) await page.getByRole("button", { name: /^(Back|Volver)/ }).first().click({ timeout: 15_000 }).catch(() => {})
        // No celular a lista de seções não tem busca: a captura é a própria lista (traduzida).
        if (!size.mobile) {
          const search = page.getByLabel(/Search settings|Buscar en los ajustes/).first()
          await search.waitFor({ timeout: 30_000 })
          await search.fill(SETTINGS_BY_LOCALE[id].query)
        }
        await page.waitForTimeout(1200)
        await page.screenshot({ path: `${OUT}/settings-search-${id}-${size.name}.png` })
        await context.close()
      })

      test(`marketplace catálogo ${id}`, async ({ browser }) => {
        test.setTimeout(240_000)
        const context = await browser.newContext({ locale: id, viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile, baseURL: test.info().project.use.baseURL })
        await context.addInitScript(() => localStorage.setItem("theme", "dark"))
        const page = await context.newPage()
        const api = new MockAtlas({ history: [] })
        const catalog = catalogHandler()
        api.handler = (request) => catalog(request) ?? baseHandler(request)
        await api.install(context)
        await page.goto("/")
        await page.getByRole("textbox").first().or(page.getByRole("button", { name: /Atlas/ })).first().waitFor({ timeout: 60_000 })
        await page.evaluate(() => window.dispatchEvent(new Event("atlas:open-marketplace")))
        await page.getByRole("tablist").first().waitFor({ timeout: 30_000 })
        await hideDevOverlay(page)
        await page.getByRole("tab", { name: /Skills|Habilidades/ }).first().click()
        await page.waitForTimeout(1800)
        await page.screenshot({ path: `${OUT}/marketplace-${id}-${size.name}.png` })
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
