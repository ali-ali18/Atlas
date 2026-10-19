import { expect, test, type Page } from "@playwright/test"
import { MockAtlas } from "./mock-api"

/**
 * Capturas (390, claro e escuro) de uma resposta de dados com tabela larga de 4 colunas.
 * Só roda com TABLE_PREVIEW_DIR definido (pasta de saída). Também confere que a tabela rola na horizontal
 * dentro do balão e que a última coluna (Valor) é alcançável.
 */
const OUT = process.env.TABLE_PREVIEW_DIR

const REPLY = [
  "Filtros: vencimento 01/09–19/10 · mais de 12 dias de atraso · em aberto",
  "| Cliente | Empresa | Vencimento | Valor |\n| --- | --- | --- | ---: |\n| Distribuidora Santa Helena de Alimentos Ltda | Matriz Comércio | 14/09/2026 | R$ 12.480,90 |\n| Mercado Bom Preço e Cia | Filial Sul | 22/09/2026 | R$ 3.215,00 |\n| Construtora Horizonte Azul S.A. | Matriz Comércio | 01/10/2026 | R$ 48.900,35 |\n| Padaria Pão de Ouro | Filial Norte | 03/10/2026 | R$ 987,40 |",
  "Total: R$ 65.583,65 em 4 títulos.",
].join("\n\n")

async function openChat(page: Page) {
  await page.goto("/")
  const bot = page.getByRole("button", { name: /Bot principal Atlas/ })
  try {
    await bot.waitFor({ timeout: 12_000 })
  } catch {
    await page.reload()
  }
  await bot.click()
  await page.getByRole("textbox", { name: /Mensagem para/ }).waitFor()
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`tabela de dados ${theme}`, () => {
    test.skip(!OUT, "defina TABLE_PREVIEW_DIR")
    test.beforeEach(async ({ context, page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await context.addInitScript((value) => localStorage.setItem("theme", value), theme)
    })

    test("tabela larga rola na horizontal", async ({ context, page }) => {
      const api = new MockAtlas({ reply: REPLY })
      await api.install(context)
      await openChat(page)
      await page.getByRole("textbox", { name: /Mensagem para/ }).fill("contas a receber vencidas")
      await page.getByRole("button", { name: "Enviar mensagem" }).click()
      const table = page.locator("table").first()
      await table.waitFor()
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
      await page.waitForTimeout(600)
      await page.screenshot({ path: `${OUT}/01-tabela-${theme}-inicio.png` })

      const scroller = page.locator('[data-slot="markdown-table"]').first()
      const metrics = await scroller.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth, viewport: window.innerWidth, right: el.getBoundingClientRect().right }))
      expect(metrics.right).toBeLessThanOrEqual(metrics.viewport)
      expect(metrics.scroll).toBeGreaterThan(metrics.client)
      await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth })
      await page.waitForTimeout(200)
      await expect(page.getByRole("columnheader", { name: "Valor" })).toBeInViewport()
      await page.screenshot({ path: `${OUT}/02-tabela-${theme}-fim.png` })
    })
  })
}
