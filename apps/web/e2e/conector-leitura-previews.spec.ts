import { test, type Page } from "@playwright/test"
import { MockAtlas } from "./mock-api"

/**
 * Capturas (escuro; 390x844 e 1440x900) da marcação "Só leitura" nas ferramentas de um conector personalizado
 * (ERP "Agroervas"): seção recolhida com o selo de sugestões, aberta com tudo pré-marcado e depois de Confirmar.
 * Só roda com CONECTOR_LEITURA_PREVIEW_DIR definido (pasta de saída).
 */
const OUT = process.env.CONECTOR_LEITURA_PREVIEW_DIR

const schema = { type: "object", properties: { pagina: { type: "number" } } }
const TOOLS = [
  { name: "avisos_ativos", description: "Consulta somente leitura dos avisos ativos.", inputSchema: schema },
  { name: "listar_pedidos", description: "Consulta somente leitura dos pedidos, por página.", inputSchema: schema },
  { name: "listar_propostas", description: "Consulta somente leitura das propostas, por página.", inputSchema: schema },
  { name: "criar_pedido", description: "Cria um pedido de venda.", inputSchema: schema },
  { name: "status_servidor", description: "Estado do servidor.", annotations: { readOnlyHint: true }, inputSchema: schema },
]
const agroervas = { id: "mcp-erp", name: "Agroervas", url: "https://erp.agroervas.example/mcp", status: "connected", catalogId: null, slug: "agroervas", authType: "none", accountLabel: null, tools: TOOLS }

const SIZES = [
  { name: "390", viewport: { width: 390, height: 844 }, mobile: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, mobile: false },
] as const

for (const size of SIZES) {
  test.describe(`previews da marcação de leitura (escuro, ${size.name}px)`, () => {
    test.skip(!OUT, "defina CONECTOR_LEITURA_PREVIEW_DIR para gerar as capturas")
    test.use({ viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile })
    test.beforeEach(async ({ context }) => {
      await context.addInitScript(() => localStorage.setItem("theme", "dark"))
    })
    const shot = async (page: Page, name: string) => {
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
      await page.waitForTimeout(500)
      await page.screenshot({ path: `${OUT}/${size.name}-${name}.png` })
    }

    test("recolhida, aberta com sugestões e confirmada", async ({ context, page }) => {
      const api = new MockAtlas({ botName: "Assistente", connectors: { catalog: [], custom: [agroervas] } })
      await api.install(context)
      await page.goto("/")
      await page.getByRole("textbox").first().or(page.getByRole("button", { name: /Bot principal/ })).first().waitFor()
      await page.evaluate(() => window.dispatchEvent(new Event("atlas:open-marketplace")))
      await page.getByRole("tablist", { name: "Seções do marketplace" }).waitFor()
      await page.getByRole("button", { name: /Ver detalhes de Agroervas/ }).click()
      const section = page.locator("[data-tool-marks]")
      await section.waitFor()
      await section.scrollIntoViewIfNeeded()
      await shot(page, "01-recolhida")

      await section.getByRole("button", { name: /Consultas sem aprovação/ }).click()
      await page.getByText("Sugestão automática").waitFor()
      await section.scrollIntoViewIfNeeded()
      await shot(page, "02-aberta-sugestoes")

      await section.getByRole("button", { name: "Confirmar" }).click()
      await page.getByText("Sugestão automática").waitFor({ state: "detached" })
      await section.scrollIntoViewIfNeeded()
      await shot(page, "03-confirmada")
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
      if (overflow) throw new Error("rolagem horizontal")
    })
  })
}
