import { test, type Page } from "@playwright/test"
import { MockAtlas } from "./mock-api"

/**
 * Capturas (escuro; 390x844 e 1440x900) de "Conectados" com uma API (Bling, ~50 grupos) e da página
 * de detalhe da conexão. Só roda com API_PAGE_PREVIEW_DIR definido (pasta de saída).
 */
const OUT = process.env.API_PAGE_PREVIEW_DIR

const NAMES = [
  "Anúncios", "Borderôs", "Campos Customizados", "Canais de Venda", "Categorias de Produtos", "Categorias de Receitas e Despesas",
  "Contas a Pagar", "Contas a Receber", "Contas Contábeis", "Contatos", "Contratos", "Depósitos", "Empresas", "Estoques",
  "Estruturas de Produtos", "Fornecedores", "Formas de Pagamento", "Grupos de Produtos", "Homologação", "Intermediadores",
  "Logísticas", "Lojas", "Naturezas de Operações", "Nota Fiscal", "Nota Fiscal de Consumidor", "Nota Fiscal de Serviço",
  "Notificações", "Ordens de Produção", "Pedidos de Compras", "Pedidos de Vendas", "Produtos", "Produtos Fornecedores",
  "Produtos Lojas", "Propostas Comerciais", "Quantidades de Estoque", "Regras de Contribuintes", "Relatórios", "Situações",
  "Situações de Módulos", "Tags", "Tipos de Contato", "Transportadoras", "Usuários", "Variações de Produtos", "Vendedores",
  "Webhooks", "Ordens de Serviço", "Unidades de Medida", "Contagens de Estoque", "Pagamentos",
]
const GROUPS = NAMES.map((tag, index) => ({ tag, total: 2 + (index % 7) * 2, read: 1 + (index % 6), write: 1 + (index % 4) }))

const connections = () => [
  {
    id: "api-1", slug: "bling-api", name: "Bling API", domain: "api.bling.com.br", baseUrl: "https://api.bling.com.br/Api/v3", authKind: "oauth2",
    status: "connected", lastError: null, groups: GROUPS, allowedTags: GROUPS.map((group) => group.tag), operationCount: 240, rateLimitRps: 3,
    createdAt: "2026-10-15T12:00:00.000Z", updatedAt: "2026-10-15T12:00:00.000Z",
  },
]

const NATIVE = [
  { id: "github", name: "GitHub", description: "Repositórios, issues e pull requests.", icon: "/connectors/github.svg", status: "connected", category: "productivity" },
  { id: "slack", name: "Slack", description: "Mensagens e canais da equipe.", icon: "/connectors/slack.svg", status: null, category: "productivity" },
  { id: "notion", name: "Notion", description: "Páginas e bancos de dados.", icon: "/connectors/notion.svg", status: null, category: "productivity" },
]

const MCP_TOOLS = [
  {
    name: "listar_pedidos", title: "Listar pedidos", annotations: { readOnlyHint: true },
    description: "Lista os pedidos de venda da Loja Exemplo, do mais recente ao mais antigo. Use os filtros para limitar por período ou situação; sem filtros devolve os últimos 50 pedidos.",
    inputSchema: { type: "object", required: ["desde"], properties: { desde: { type: "string", description: "Data inicial no formato AAAA-MM-DD." }, situacao: { type: "string", enum: ["aberto", "atendido", "cancelado"], description: "Filtra pelo estado do pedido." }, limite: { type: "integer", description: "Quantidade máxima de pedidos (padrão 50)." } } },
  },
  {
    name: "criar_pedido", title: "Criar pedido", annotations: { readOnlyHint: false, destructiveHint: false },
    description: "Cria um pedido de venda novo.",
    inputSchema: { type: "object", required: ["cliente", "itens"], properties: { cliente: { type: "string", description: "Identificador do cliente." }, itens: { type: "array", items: { type: "object" }, description: "Produtos e quantidades do pedido." } } },
  },
  { name: "cancelar_pedido", title: "Cancelar pedido", annotations: { destructiveHint: true }, description: "Cancela um pedido e devolve o estoque.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
]
const CUSTOM = [
  { id: "mcp-1", name: "Loja Exemplo", url: "https://mcp.loja-exemplo.com.br/mcp", status: "connected", authType: "oauth", tools: MCP_TOOLS },
  { id: "mcp-2", name: "n8n", url: "https://n8n.exemplo.com.br/mcp-server", status: "connected", authType: "api_key", tools: MCP_TOOLS.slice(0, 1) },
]

const SIZES = [
  { name: "390", viewport: { width: 390, height: 844 }, mobile: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, mobile: false },
] as const

for (const size of SIZES) {
  test.describe(`previews da página da API (escuro, ${size.name}px)`, () => {
    test.skip(!OUT, "defina API_PAGE_PREVIEW_DIR para gerar as capturas")
    test.use({ viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile })
    test.beforeEach(async ({ context }) => {
      await context.addInitScript(() => localStorage.setItem("theme", "dark"))
    })
    const shot = async (page: Page, name: string, fullPage = false) => {
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
      await page.waitForTimeout(500)
      await page.screenshot({ fullPage, path: `${OUT}/${size.name}-${name}.png` })
    }

    test("lista e página da conexão", async ({ context, page }) => {
      const api = new MockAtlas({ botName: "Assistente", apiConnections: connections(), connectors: { catalog: NATIVE, custom: CUSTOM } })
      await api.install(context)
      await page.goto("/")
      await page.getByRole("textbox").first().or(page.getByRole("button", { name: /Bot principal/ })).first().waitFor()
      await page.evaluate(() => window.dispatchEvent(new Event("atlas:open-marketplace")))
      await page.getByRole("tablist", { name: "Seções do marketplace" }).waitFor()
      await page.getByRole("button", { name: "Ver detalhes de Bling API" }).waitFor()
      if (!size.mobile) await page.getByText("Instalados: 3").waitFor()
      await shot(page, "01-lista")
      await page.getByRole("button", { name: "Ver detalhes de Bling API" }).click()
      await page.getByRole("heading", { name: /^Grupos/ }).waitFor()
      await shot(page, "02-pagina")
      await page.getByRole("switch", { name: "Borderôs" }).click()
      await page.getByText("49 de 50").first().waitFor()
      await page.getByLabel("Buscar grupo").fill("pedidos")
      await page.getByRole("button", { name: /Pedidos de Vendas/ }).click()
      await page.getByRole("button", { name: /Lista pedidos de vendas/ }).waitFor()
      await shot(page, "03-busca-e-grupo-aberto")
      await page.getByRole("button", { name: /Lista pedidos de vendas/ }).click()
      await page.getByRole("heading", { name: "Lista pedidos de vendas" }).last().waitFor()
      await shot(page, "04-guia-operacao-api")
      await page.getByRole("button", { name: "Fechar" }).click()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
      if (overflow) throw new Error("rolagem horizontal")
      await page.goBack()
      await page.getByRole("button", { name: "Ver detalhes de Bling API" }).waitFor()
      await page.getByRole("button", { name: "Ver detalhes de Loja Exemplo" }).click()
      await page.getByRole("button", { name: "Guia da ferramenta Listar pedidos" }).click()
      await page.getByRole("heading", { name: "Listar pedidos" }).last().waitFor()
      await shot(page, "05-guia-ferramenta-mcp")
      await page.getByRole("button", { name: "Fechar" }).click()
      await shot(page, "06-detalhe-mcp")
      await page.goBack()
      await page.getByRole("button", { name: "Personalizado" }).click()
      await shot(page, "07-menu-personalizado")
    })
  })
}
