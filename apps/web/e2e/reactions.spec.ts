import { expect, test, type Page } from "@playwright/test"
import { MockAtlas } from "./mock-api"

/**
 * Reações persistidas e "responder só com reação" no celular (390x844, API simulada no navegador).
 * Com REACTIONS_PREVIEW_DIR definido, também grava as capturas de tela (tema escuro) nessa pasta.
 */
const OUT = process.env.REACTIONS_PREVIEW_DIR

const HISTORY = [
  { role: "user" as const, content: "me manda o relatório de vendas de ontem" },
  { role: "assistant" as const, content: "Enviei o relatório de ontem: R$ 12.480,00 em 37 pedidos, 4 a mais que anteontem." },
]

async function openChat(page: Page) {
  await page.goto("/")
  const bot = page.getByRole("button", { name: /Bot principal Atlas/ })
  try {
    await bot.waitFor({ timeout: 12_000 })
  } catch {
    await page.reload()
  }
  await bot.click()
  await expect(page.getByRole("textbox").first()).toBeVisible()
}

async function send(page: Page, text: string) {
  const input = page.getByRole("textbox").first()
  await input.fill(text)
  await page.getByRole("button", { name: "Enviar mensagem" }).click()
}

async function shot(page: Page, name: string) {
  if (!OUT) return
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
  await page.screenshot({ path: `${OUT}/${name}.png` })
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => localStorage.setItem("theme", "dark"))
})

test("valeu!: o bot só reage com ❤️, sem balão de resposta, sem run e sem 'trabalhando'", async ({ context, page }) => {
  const api = new MockAtlas({ history: HISTORY, reactionOnly: true })
  await api.install(context)
  await openChat(page)
  await send(page, "valeu!")
  await expect(page.getByText("valeu!", { exact: true })).toBeVisible()
  await expect(page.getByRole("img", { name: "Reação: ❤️" })).toBeVisible()
  // nenhuma resposta, nenhum run e o composer livre
  await page.waitForTimeout(800)
  expect(api.requests.filter((r) => r.path.startsWith("/v1/runs/"))).toEqual([])
  await expect(page.getByText("Olá! Aqui está a resposta do bot.")).toHaveCount(0)
  await expect(page.getByRole("textbox").first()).toBeEnabled()
  await shot(page, "01-valeu-com-coracao-do-bot")
  // continua igual depois de recarregar (veio do servidor)
  await page.reload()
  await page.getByRole("button", { name: /Bot principal Atlas/ }).click()
  await expect(page.getByRole("img", { name: "Reação: ❤️" })).toBeVisible()
})

test("pedido com 'ok' no começo segue o fluxo normal (não é só reação)", async ({ context, page }) => {
  const api = new MockAtlas({ history: HISTORY, reactionOnly: false })
  await api.install(context)
  await openChat(page)
  await send(page, "ok, manda o relatório")
  await expect(page.getByText("Olá! Aqui está a resposta do bot.").first()).toBeVisible()
})

test("reação do usuário numa fala do bot persiste depois de recarregar e some ao tocar de novo", async ({ context, page }) => {
  const api = new MockAtlas({ history: HISTORY })
  await api.install(context)
  await openChat(page)
  await page.getByRole("button", { name: "Reagir" }).last().click({ force: true })
  await page.getByRole("button", { name: "Reagir com 👍" }).click()
  await expect(page.getByRole("img", { name: "Reação: 👍" })).toBeVisible()
  expect(api.messages.find((m) => m.role === "assistant")?.reactions).toEqual([{ actor: "user", emoji: "👍" }])
  await page.reload()
  await page.getByRole("button", { name: /Bot principal Atlas/ }).click()
  await expect(page.getByRole("img", { name: "Reação: 👍" })).toBeVisible()
  await shot(page, "02-reacao-do-usuario-depois-de-recarregar")
  await page.getByRole("button", { name: "Reagir" }).last().click({ force: true })
  await page.getByRole("button", { name: "Reagir com 👍" }).click()
  await expect(page.getByRole("img", { name: "Reação: 👍" })).toHaveCount(0)
  expect(api.messages.find((m) => m.role === "assistant")?.reactions).toEqual([])
})

test("falha ao salvar: a reação volta e aparece o aviso", async ({ context, page }) => {
  const api = new MockAtlas({ history: HISTORY, failReactions: true })
  await api.install(context)
  await openChat(page)
  await page.getByRole("button", { name: "Reagir" }).last().click({ force: true })
  await page.getByRole("button", { name: "Reagir com ❤️" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Não foi possível salvar a reação" })).toBeVisible()
  await expect(page.getByRole("img", { name: /Reação/ })).toHaveCount(0)
  await shot(page, "04-falha-ao-reagir-aviso")
})

test("configuração 'Responder só com reação' aparece ligada em Avançado", async ({ context, page }) => {
  const api = new MockAtlas({ history: HISTORY })
  await api.install(context)
  await openChat(page)
  await page.goto("/?settings=avancado")
  const row = page.getByText("Responder só com reação quando não precisa de resposta").first()
  await expect(row).toBeVisible()
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }))
  await expect(page.locator("input#settings-exec-reaction-only")).toBeChecked()
  await shot(page, "03-configuracao-responder-so-com-reacao")
})
