import { test, type Page } from "@playwright/test"
import { MockAtlas } from "./mock-api"

/**
 * Capturas (390x844, escuro) do card "Conectar API" e da lista de conectores com a API conectada.
 * Só roda com API_PREVIEW_DIR definido (pasta de saída); fora disso é pulado.
 */
const OUT = process.env.API_PREVIEW_DIR
const BOT = "Assistente"

const GROUPS = [
  { tag: "Contatos", total: 3, read: 2, write: 1 },
  { tag: "Pedidos de Vendas", total: 12, read: 5, write: 7 },
  { tag: "Produtos", total: 14, read: 6, write: 8 },
  { tag: "Estoques", total: 4, read: 2, write: 2 },
  { tag: "Nota Fiscal", total: 6, read: 3, write: 3 },
]

const PROPOSAL = {
  specUrl: "https://developer.bling.example/openapi.json",
  name: "Bling API",
  domain: "api.bling.example",
  baseUrl: "https://api.bling.example/Api/v3",
  authKind: "oauth2",
  operationCount: 39,
  readCount: 18,
  groups: GROUPS,
  redirectUrl: "http://127.0.0.1:3200/v1/mcp/oauth/callback",
}

const CONNECTIONS = [
  {
    id: "api-1", slug: "bling-api", name: "Bling API", domain: "api.bling.example", baseUrl: "https://api.bling.example/Api/v3", authKind: "oauth2",
    status: "connected", lastError: null, groups: GROUPS, allowedTags: ["Contatos", "Pedidos de Vendas", "Produtos"], operationCount: 39, rateLimitRps: 3,
    createdAt: "2026-10-15T12:00:00.000Z", updatedAt: "2026-10-15T12:00:00.000Z",
  },
  {
    id: "api-2", slug: "loja-legado", name: "Loja Legado", domain: "api.legado.example", baseUrl: "https://api.legado.example/v1", authKind: "apiKey",
    status: "pending_auth", lastError: "O login expirou ou foi revogado", groups: [{ tag: "Itens", total: 2, read: 2, write: 0 }], allowedTags: ["Itens"], operationCount: 2, rateLimitRps: 3,
    createdAt: "2026-10-15T12:00:00.000Z", updatedAt: "2026-10-15T12:00:00.000Z",
  },
]

async function openChat(page: Page) {
  await page.goto("/")
  const bot = page.getByRole("button", { name: new RegExp(`Bot principal ${BOT}`) })
  try {
    await bot.waitFor({ timeout: 12_000 })
  } catch {
    await page.reload()
  }
  await bot.click()
}

test.describe("previews Conectar API (escuro)", () => {
  test.skip(!OUT, "defina API_PREVIEW_DIR para gerar as capturas")
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => localStorage.setItem("theme", "dark"))
  })
  // Esconde o indicador "Compiling" do `next dev`, que não faz parte da tela.
  const shot = async (page: Page, name: string) => {
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
    await page.screenshot({ path: `${OUT}/${name}.png` })
  }

  const loginCard = (status?: "done") => ({
    loginId: "connector-run-api-bling-api", site: "Bling API", url: PROPOSAL.baseUrl, ...(status ? { status } : {}),
    connector: { kind: "api", id: "bling-api", name: "Bling API", description: "", icon: null, api: PROPOSAL },
  })

  test("card compacto, folha em passos e conectado", async ({ context, page }) => {
    const api = new MockAtlas({ botName: BOT, reply: "ok", loginCard: loginCard() })
    await api.install(context)
    await openChat(page)
    const card = page.getByRole("region", { name: "Conectar Bling" })
    await card.waitFor()
    await card.evaluate((el) => el.scrollIntoView({ block: "center" }))
    await shot(page, "01-card-compacto")
    await card.getByRole("button", { name: "Detalhes" }).click()
    await shot(page, "02-card-detalhes")
    await card.getByRole("button", { name: "Conectar", exact: true }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByText("Credenciais", { exact: true }).waitFor()
    await shot(page, "03-folha-passo-1")
    await dialog.getByRole("button", { name: "Onde encontro isso?" }).click()
    await shot(page, "04-folha-onde-encontro")
    await dialog.getByLabel("Client ID").fill("a1b2c3d4-client-id")
    await dialog.getByLabel("Client secret").fill("segredo-que-nao-aparece")
    await dialog.getByRole("button", { name: "Continuar" }).click()
    await dialog.getByText("Tudo em modo leitura").waitFor()
    await shot(page, "05-folha-passo-2")
  })

  test("card conectado em uma linha", async ({ context, page }) => {
    const api = new MockAtlas({ botName: BOT, reply: "ok", loginCard: loginCard("done"), apiConnections: CONNECTIONS })
    await api.install(context)
    await openChat(page)
    await page.getByRole("region", { name: "Bling conectado" }).waitFor()
    await shot(page, "06-card-conectado")
  })

  test("lista de conectores com API conectada", async ({ context, page }) => {
    const api = new MockAtlas({ botName: BOT, apiConnections: CONNECTIONS, connectors: { catalog: [], custom: [] } })
    await api.install(context)
    await openChat(page)
    await page.getByRole("textbox").first().waitFor()
    await page.evaluate(() => window.dispatchEvent(new Event("atlas:open-marketplace")))
    await page.getByRole("heading", { name: "APIs conectadas" }).waitFor()
    await shot(page, "07-conectores-api-conectada")
    await page.getByRole("button", { name: "Grupos" }).first().click()
    await shot(page, "08-conectores-grupos")
  })

  test("Conectar API manual: entrada, link e erro", async ({ context, page }) => {
    const api = new MockAtlas({ botName: BOT, apiConnections: CONNECTIONS, apiProposal: PROPOSAL, connectors: { catalog: [], custom: [] } })
    await api.install(context)
    await openChat(page)
    await page.getByRole("textbox").first().waitFor()
    await page.evaluate(() => window.dispatchEvent(new Event("atlas:open-marketplace")))
    await page.getByRole("heading", { name: "APIs conectadas" }).waitFor()
    const entry = page.getByRole("button", { name: "Conectar API", exact: true })
    await entry.evaluate((el) => el.scrollIntoView({ block: "center" }))
    await shot(page, "09-conectores-conectar-api")
    await entry.click()
    const sheet = page.getByRole("dialog").last()
    await sheet.getByRole("heading", { name: "Link da API" }).waitFor()
    await shot(page, "10-link-da-api")
    await sheet.getByLabel("Link da API").fill("https://docs.exemplo.test/erro")
    await sheet.getByRole("button", { name: "Continuar" }).click()
    await sheet.getByRole("alert").waitFor()
    await shot(page, "11-link-da-api-erro")
    await sheet.getByLabel("Link da API").fill("https://developer.bling.example/openapi.json")
    await sheet.getByRole("button", { name: "Continuar" }).click()
    await sheet.getByText("Credenciais", { exact: true }).waitFor()
    await shot(page, "12-credenciais-apos-link")
  })

  test("card com link encontrado pelo bot", async ({ context, page }) => {
    const found = { ...loginCard(), connector: { ...loginCard().connector, api: { ...PROPOSAL, foundByBot: true, specUrl: "https://developer.bling.com.br/build/assets/openapi.json" } } }
    const api = new MockAtlas({ botName: BOT, reply: "ok", loginCard: found })
    await api.install(context)
    await openChat(page)
    const card = page.getByRole("region", { name: "Conectar Bling" })
    await card.waitFor()
    await card.evaluate((el) => el.scrollIntoView({ block: "center" }))
    await shot(page, "13-card-link-do-bot")
  })

  test("desktop 1440: modal centralizado", async ({ context, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const api = new MockAtlas({ botName: BOT, reply: "ok", loginCard: loginCard(), apiProposal: PROPOSAL })
    await api.install(context)
    await openChat(page)
    const card = page.getByRole("region", { name: "Conectar Bling" })
    await card.waitFor()
    await card.getByRole("button", { name: "Conectar", exact: true }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByText("Credenciais", { exact: true }).waitFor()
    await shot(page, "14-desktop-credenciais")
    await dialog.getByLabel("Client ID").fill("a1b2c3d4-client-id")
    await dialog.getByLabel("Client secret").fill("segredo-que-nao-aparece")
    await dialog.getByRole("button", { name: "Continuar" }).click()
    await dialog.getByText("Tudo em modo leitura").waitFor()
    await shot(page, "15-desktop-acesso")
  })
})
