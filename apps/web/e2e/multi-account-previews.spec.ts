import { test, type Page } from "@playwright/test"
import { MockAtlas } from "./mock-api"

/**
 * Capturas (escuro; 390x844 e 1440x900) de várias contas do mesmo conector: duas contas Notion (MCP do
 * catálogo) e duas contas Bling (API) em "Conectados" e a seção "Contas" do detalhe de cada uma.
 * Só roda com MULTI_ACCOUNT_PREVIEW_DIR definido (pasta de saída).
 */
const OUT = process.env.MULTI_ACCOUNT_PREVIEW_DIR

const GROUPS = ["Pedidos de Vendas", "Produtos", "Estoques", "Contatos", "Contas a Receber", "Nota Fiscal"].map((tag, index) => ({
  tag, total: 4 + index, read: 2 + (index % 3), write: 1 + (index % 2),
}))

const bling = (id: string, slug: string, accountLabel: string | null, status = "connected") => ({
  id, slug, name: "Bling", domain: "api.bling.com.br", baseUrl: "https://api.bling.com.br/Api/v3", authKind: "oauth2",
  status, lastError: status === "connected" ? null : "O login expirou ou foi revogado", groups: GROUPS, allowedTags: GROUPS.slice(0, 4).map((group) => group.tag),
  operationCount: 120, rateLimitRps: 3, accountLabel, createdAt: "2026-10-15T12:00:00.000Z", updatedAt: "2026-10-15T12:00:00.000Z",
})

const NATIVE = [
  { id: "github", name: "GitHub", description: "Repositórios, issues e pull requests.", icon: "/connectors/github.svg", status: null, category: "productivity" },
  { id: "slack", name: "Slack", description: "Mensagens e canais da equipe.", icon: "/connectors/slack.svg", status: null, category: "productivity" },
  {
    id: "notion", name: "Notion", description: "Páginas e bancos de dados.", longDescription: "Leia, crie e edite páginas e bancos de dados do Notion.",
    icon: "/connectors/notion.svg", status: null, category: "productivity", developer: "Notion", website: "notion.so", sourceUrl: "https://developers.notion.com",
  },
]

const TOOLS = [
  { name: "buscar_paginas", title: "Buscar páginas", annotations: { readOnlyHint: true }, description: "Busca páginas e bancos de dados pelo título.", inputSchema: { type: "object", properties: { consulta: { type: "string" } } } },
  { name: "criar_pagina", title: "Criar página", annotations: { readOnlyHint: false }, description: "Cria uma página nova.", inputSchema: { type: "object", properties: { titulo: { type: "string" } } } },
]
const notion = (id: string, slug: string, accountLabel: string | null, status = "connected") => ({
  id, name: "Notion", url: "https://mcp.notion.com/mcp", status, catalogId: "notion", slug, authType: "oauth", accountLabel, tools: TOOLS,
})

const PROPOSAL = {
  specUrl: "https://developer.bling.com.br/openapi.json", name: "Bling", domain: "api.bling.com.br", baseUrl: "https://api.bling.com.br/Api/v3",
  authKind: "oauth2", redirectUrl: "https://app.exemplo.com.br/v1/mcp/oauth/callback", operationCount: 120, readCount: 40, groups: GROUPS,
}

const SIZES = [
  { name: "390", viewport: { width: 390, height: 844 }, mobile: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, mobile: false },
] as const

for (const size of SIZES) {
  test.describe(`previews de várias contas (escuro, ${size.name}px)`, () => {
    test.skip(!OUT, "defina MULTI_ACCOUNT_PREVIEW_DIR para gerar as capturas")
    test.use({ viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile })
    test.beforeEach(async ({ context }) => {
      await context.addInitScript(() => localStorage.setItem("theme", "dark"))
    })
    const shot = async (page: Page, name: string, fullPage = false) => {
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
      await page.waitForTimeout(500)
      await page.screenshot({ fullPage, path: `${OUT}/${size.name}-${name}.png` })
    }

    test("lista e detalhes com várias contas", async ({ context, page }) => {
      const api = new MockAtlas({
        botName: "Assistente",
        apiConnections: [bling("api-1", "bling", "Bling loja"), bling("api-2", "bling-2", "Bling atacado", "pending_auth")],
        apiProposal: PROPOSAL,
        connectors: { catalog: NATIVE, custom: [notion("mcp-1", "notion", "Notion pessoal"), notion("mcp-2", "notion-2", null)] },
      })
      await api.install(context)
      await page.goto("/")
      await page.getByRole("textbox").first().or(page.getByRole("button", { name: /Bot principal/ })).first().waitFor()
      await page.evaluate(() => window.dispatchEvent(new Event("atlas:open-marketplace")))
      await page.getByRole("tablist", { name: "Seções do marketplace" }).waitFor()
      await page.getByRole("button", { name: "Ver detalhes de Notion — 2 contas" }).waitFor()
      if (!size.mobile) await page.getByText("Instalados: 2").waitFor()
      await shot(page, "01-lista")

      // Notion: detalhe com a seção Contas.
      await page.getByRole("button", { name: "Ver detalhes de Notion — 2 contas" }).click()
      await page.getByRole("region", { name: "Contas" }).waitFor()
      await shot(page, "02-notion-detalhe")
      await shot(page, "02b-notion-detalhe-completo", true)
      await page.getByRole("tab", { name: "Notion pessoal" }).click()
      await page.getByRole("tab", { name: "Notion pessoal", selected: true }).waitFor()
      await shot(page, "02c-notion-configuracao-outra-conta", true)
      await page.getByRole("button", { name: "Renomear Conta 2" }).click()
      await page.getByLabel("Apelido da conta").fill("Notion trabalho")
      await shot(page, "03-notion-renomear")
      await page.getByLabel("Apelido da conta").press("Enter")
      await page.getByText("Notion trabalho").first().waitFor()
      await shot(page, "04-notion-renomeado")
      let overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
      if (overflow) throw new Error("rolagem horizontal (Notion)")
      await page.goBack()

      // Bling (API): detalhe com a seção Contas e o fluxo de outra conta.
      await page.getByRole("button", { name: "Ver detalhes de Bling" }).click()
      await page.getByRole("region", { name: "Contas" }).waitFor()
      await shot(page, "05-bling-detalhe")
      await page.getByRole("button", { name: "Adicionar outra conta" }).click()
      await page.getByLabel(/Client ID|Client id/i).first().waitFor()
      await shot(page, "06-bling-outra-conta-credenciais")
      await page.getByLabel(/Client ID|Client id/i).first().fill("cliente-123456")
      await page.getByLabel(/Client secret/i).first().fill("segredo-123456")
      await page.getByRole("button", { name: "Continuar" }).click()
      await page.getByText("Para usar outra conta").last().waitFor()
      await shot(page, "07-bling-outra-conta-autorizar")
      await page.getByRole("button", { name: "Cancelar" }).click()
      overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
      if (overflow) throw new Error("rolagem horizontal (Bling)")
    })
  })
}
