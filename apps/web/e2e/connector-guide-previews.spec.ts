import { test, type Page } from "@playwright/test"
import { MockAtlas } from "./mock-api"

/**
 * Capturas (390x844, claro e escuro) do bloco "Guia de uso" no detalhe de um conector: recolhido com
 * sugestão do bot, expandido, em edição e com a confirmação de "Gerar de novo".
 * Só roda com GUIDE_PREVIEW_DIR definido (pasta de saída).
 */
const OUT = process.env.GUIDE_PREVIEW_DIR

const NATIVE = [
  {
    id: "notion", name: "Notion", description: "Páginas e bancos de dados.", longDescription: "Leia, crie e edite páginas e bancos de dados do Notion.",
    icon: "/connectors/notion.svg", status: null, category: "productivity", developer: "Notion", website: "notion.so", sourceUrl: "https://developers.notion.com",
  },
]

const TOOLS = [
  { name: "buscar_paginas", title: "Buscar páginas", annotations: { readOnlyHint: true }, description: "Busca páginas e bancos de dados pelo título.", inputSchema: { type: "object", properties: { consulta: { type: "string" } } } },
  { name: "abrir_pagina", title: "Abrir página", annotations: { readOnlyHint: true }, description: "Abre uma página pelo id.", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
]

const GUIDE_TEXT = [
  "- Use `buscar_paginas` para achar a página e `abrir_pagina` só para ler o conteúdo.",
  "- Passe a `abrir_pagina` o `id` interno devolvido pela busca, não o título nem o número exibido.",
  "- Datas no formato AAAA-MM-DD.",
  "- Filtros opcionais (como status) só entram se o usuário pedir.",
  "- Resultados vêm paginados: use o cursor devolvido para a próxima página.",
  "- Em caso de lista vazia, tente sem filtros antes de concluir que não existe.",
].join("\n")

const GUIDE = {
  text: GUIDE_TEXT,
  source: "generated",
  updatedAt: "2026-10-15T12:00:00.000Z",
  suggestions: [{ id: "s1", text: "Quando a busca devolver mais de um resultado, confirme com o usuário qual abrir.", createdAt: "2026-10-16T12:00:00.000Z" }],
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`previews do guia do conector (${theme}, 390px)`, () => {
    test.skip(!OUT, "defina GUIDE_PREVIEW_DIR para gerar as capturas")
    test.beforeEach(async ({ context }) => {
      await context.addInitScript((value) => localStorage.setItem("theme", value), theme)
    })
    const shot = async (page: Page, name: string) => {
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
      await page.locator('[data-slot="connector-guide"]').scrollIntoViewIfNeeded()
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${OUT}/${theme}-${name}.png` })
    }

    test("guia: recolhido, expandido, edição e confirmação", async ({ context, page }) => {
      const api = new MockAtlas({
        botName: "Assistente",
        connectors: {
          catalog: NATIVE,
          custom: [{ id: "mcp-1", name: "Notion", url: "https://mcp.notion.com/mcp", status: "connected", catalogId: "notion", slug: "notion", authType: "oauth", accountLabel: null, tools: TOOLS, guide: GUIDE } as never],
        },
      })
      await api.install(context)
      let guide: typeof GUIDE | null = GUIDE
      await context.route("**/v1/connectors/mcp/mcp-1/guide**", async (route) => {
        const request = route.request()
        const path = new URL(request.url()).pathname
        const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
        if (request.method() === "GET") return json({ guide })
        if (request.method() === "PUT") {
          const { text } = request.postDataJSON() as { text: string }
          guide = { ...(guide ?? GUIDE), text, source: "user", updatedAt: new Date().toISOString() }
          return json({ guide })
        }
        if (path.endsWith("/accept") && guide) {
          guide = { ...guide, text: `${guide.text}\n- ${guide.suggestions[0]!.text}`, source: "user", suggestions: [] }
          return json({ guide })
        }
        return json({ queued: true }, 202)
      })
      await page.goto("/")
      await page.getByRole("textbox").first().or(page.getByRole("button", { name: /Bot principal/ })).first().waitFor()
      await page.evaluate(() => window.dispatchEvent(new Event("atlas:open-marketplace")))
      await page.getByRole("tablist", { name: "Seções do marketplace" }).waitFor()
      await page.getByRole("button", { name: /Ver detalhes de Notion/ }).first().click()
      await page.getByRole("region", { name: "Guia de uso" }).waitFor()
      await shot(page, "01-fechado")
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
      if (await overflow()) throw new Error("rolagem horizontal (guia fechado)")
      await page.getByRole("button", { name: /Guia de uso/ }).click()
      await page.getByRole("button", { name: "Editar" }).waitFor()
      await shot(page, "02-aberto-com-sugestao")

      await page.getByRole("button", { name: "Editar" }).click()
      await page.getByLabel("Texto do guia").fill(`${GUIDE_TEXT}\n- Nunca invente ids.`)
      await shot(page, "03-editando")
      if (await overflow()) throw new Error("rolagem horizontal (edição)")

      await page.getByRole("button", { name: "Salvar" }).click()
      await page.getByText("Editado por você").waitFor()
      await page.getByRole("button", { name: "Gerar de novo" }).click()
      await page.getByText("Substituir o guia editado?").waitFor()
      await shot(page, "04-confirmar-gerar-de-novo")
    })
  })
}
