import { test, type Page } from "@playwright/test"
import { MockAtlas } from "./mock-api"

/** Capturas (390x844 escuro e 1440x900) das gavetas com fundo desfocado. Só roda com DRAWER_PREVIEW_DIR definido. */
const OUT = process.env.DRAWER_PREVIEW_DIR

async function openApp(page: Page) {
  await page.goto("/")
  const bot = page.getByRole("button", { name: /Bot principal Atlas/ })
  try {
    await bot.waitFor({ timeout: 12_000 })
  } catch {
    await page.reload()
  }
  await bot.click()
  await page.getByRole("textbox").first().waitFor()
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
}

test.describe("previews gavetas", () => {
  test.skip(!OUT, "defina DRAWER_PREVIEW_DIR para gerar as capturas")
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => localStorage.setItem("theme", "dark"))
    await new MockAtlas({}).install(context)
  })
  const shot = async (page: Page, name: string) => {
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
    await page.screenshot({ path: `${OUT}/${name}.png` })
  }

  test("add menu e painel no celular", async ({ page }) => {
    await openApp(page)
    await page.getByRole("button", { name: "Adicionar" }).click()
    await page.locator("[data-add-drawer]").waitFor()
    await page.waitForTimeout(400)
    await shot(page, "01-add-menu-fundo-desfocado")
    await page.mouse.click(195, 60)
    await page.locator("[data-add-drawer]").waitFor({ state: "detached" })
    await page.getByRole("button", { name: "Alternar painel" }).click()
    await page.locator('[data-slot="info-pane-backdrop"]').waitFor()
    await page.waitForTimeout(500)
    await shot(page, "02-painel-celular-fundo")
    await page.mouse.click(30, 400)
    await page.locator('[data-slot="info-pane-backdrop"]').waitFor({ state: "detached" })
  })

  test.describe("desktop", () => {
    test.use({ viewport: { width: 1440, height: 900 } })
    test("dialog no desktop", async ({ page }) => {
      await openApp(page)
      await page.getByRole("button", { name: "Marketplace" }).first().click()
      await page.waitForTimeout(500)
      await shot(page, "03-desktop-1440")
    })
  })
})
