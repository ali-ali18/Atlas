import { expect, test, type Page } from "@playwright/test"
import { MockAtlas } from "./mock-api"

/**
 * Fluxos principais no celular (390x844): login stub, mandar mensagem e receber a resposta, sair do app
 * (visibilitychange hidden/visible) e voltar com a resposta presente, aprovar um cartão e sair.
 * A API é simulada no navegador (ver mock-api.ts).
 */

async function setVisibility(page: Page, state: "hidden" | "visible") {
  await page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => next })
    Object.defineProperty(document, "hidden", { configurable: true, get: () => next === "hidden" })
    document.dispatchEvent(new Event("visibilitychange"))
    window.dispatchEvent(new Event(next === "hidden" ? "pagehide" : "pageshow"))
  }, state)
}

async function openChat(page: Page) {
  await page.goto("/")
  await page.getByRole("button", { name: /Bot principal Atlas/ }).click()
  await expect(page.getByRole("textbox").first()).toBeVisible()
}

test("login stub: sem sessão cai no /login; com sessão abre o app", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL })
  const page = await context.newPage()
  await page.goto("/")
  await expect(page).toHaveURL(/\/login/)
  await context.close()
})

test("manda uma mensagem e recebe a resposta", async ({ context, page }) => {
  const api = new MockAtlas({ reply: "Resposta do bot de teste." })
  await api.install(context)
  await openChat(page)
  const input = page.getByRole("textbox").first()
  await input.fill("Oi, bot")
  await input.press("Enter")
  await expect(page.getByText("Resposta do bot de teste.").first()).toBeVisible()
  expect(api.postedObjectives()).toEqual(["Oi, bot"])
})

test("sai do app (hidden) e volta (visible) com a resposta presente", async ({ context, page }) => {
  const api = new MockAtlas({ reply: "Resposta que chegou com o app em segundo plano.", replyDelayMs: 1500 })
  await api.install(context)
  await openChat(page)
  const input = page.getByRole("textbox").first()
  await input.fill("Pesquisa algo demorado")
  await input.press("Enter")
  await setVisibility(page, "hidden")
  // O servidor termina o run enquanto o app está em segundo plano.
  await expect.poll(() => api.messages.some((m) => m.role === "assistant"), { timeout: 10_000 }).toBe(true)
  await setVisibility(page, "visible")
  await expect(page.getByText("Resposta que chegou com o app em segundo plano.").first()).toBeVisible()
})

test("aprova um cartão de confirmação", async ({ context, page }) => {
  const api = new MockAtlas({ confirmCard: { confirmId: "c1", title: "Executar pnpm test", description: "Rodar os testes" } })
  await api.install(context)
  await openChat(page)
  await expect(page.getByText("Executar pnpm test").first()).toBeVisible()
  await page.getByRole("button", { name: "Executar", exact: true }).first().click()
  await expect.poll(() => api.postedObjectives()).toContain("confirmado: Executar pnpm test")
  await expect(page.getByText("Feito: comando executado.").first()).toBeVisible()
})

test("sai da conta pelo menu", async ({ context, page }) => {
  const api = new MockAtlas()
  await api.install(context)
  await page.goto("/")
  await page.getByRole("button", { name: /Menu da conta/ }).click()
  await page.getByRole("menuitem", { name: /Sair/ }).click()
  await expect.poll(() => api.requests.some((r) => r.path.endsWith("/sign-out"))).toBe(true)
})
