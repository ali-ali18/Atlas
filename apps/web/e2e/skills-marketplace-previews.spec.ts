import { test, type Page } from "@playwright/test"
import { catalogHandler } from "./marketplace-fixtures"
import { MockAtlas, type MockHandler } from "./mock-api"

/**
 * Capturas (escuro; 390x844 e 1440x900) da PÁGINA do Marketplace: abas Conectores, Apps, Agentes e
 * Habilidades, detalhes, instalar (escopo e agente), atualização com cópia editada e publicar (folha
 * empilhada sobre as Configurações, para conferir o escurecimento + desfoque do fundo).
 * Só roda com SKILLS_PREVIEW_DIR (pasta de saída); SKILLS_CATALOG_DIR aponta o clone do catálogo para
 * usar o SKILL.md real do Roblox na página da habilidade.
 */
const OUT = process.env.SKILLS_PREVIEW_DIR

const NATIVE = [
  { id: "github", name: "GitHub", description: "Repositórios, issues e pull requests.", icon: "/connectors/github.svg", status: "connected", category: "productivity" },
  { id: "slack", name: "Slack", description: "Mensagens e canais da equipe.", icon: "/connectors/slack.svg", status: null, category: "productivity" },
  { id: "google_drive", name: "Google Drive", description: "Arquivos e pastas.", icon: "/connectors/google-drive.svg", status: null, category: "google" },
  { id: "gmail", name: "Gmail", description: "Ler e redigir e-mails.", icon: "/connectors/gmail.svg", status: null, category: "google" },
  { id: "notion", name: "Notion", description: "Páginas e bancos de dados.", icon: "/connectors/notion.svg", status: null, category: "productivity" },
  { id: "firecrawl", name: "Firecrawl", description: "Pesquisa e leitura de páginas da web.", icon: "/connectors/firecrawl.svg", status: null, category: "search" },
]

const TOOLKITS = [
  ["linear", "Linear", "Issues e projetos de produto."],
  ["trello", "Trello", "Quadros, listas e cartões."],
  ["hubspot", "HubSpot", "CRM, contatos e negócios."],
  ["asana", "Asana", "Tarefas e projetos da equipe."],
  ["stripe", "Stripe", "Pagamentos e assinaturas."],
  ["airtable", "Airtable", "Bases e registros."],
].map(([slug, name, description]) => ({ slug, name, description, logo: null, connected: false, noAuth: false, nativeCatalogId: null }))

const composioHandler: MockHandler = ({ method, path }) => {
  if (method === "GET" && path === "/v1/composio/status") return { body: { configured: true, keyHint: "••••4f2a", secretBoxReady: true, toolCount: 0 } }
  if (method === "GET" && path === "/v1/composio/toolkits") return { body: { items: TOOLKITS, nextCursor: "c2", totalItems: 24 } }
  if (method === "GET" && path === "/v1/composio/categories") return { body: { categories: [] } }
  if (method === "GET" && path === "/v1/composio/connections") return { body: { connections: [] } }
  return undefined
}

function withHandlers(...handlers: MockHandler[]): MockHandler {
  return (request) => {
    for (const handler of handlers) {
      const result = handler(request)
      if (result) return result
    }
    return undefined
  }
}

const SECTION_LABEL: Record<string, string> = { conectores: "Conectores", apps: "Apps", agentes: "Agentes", habilidades: "Habilidades" }

async function openMarketplace(page: Page, section = "conectores") {
  await page.goto("/")
  // No celular a home é a lista de conversas (sem campo de texto); no computador já abre o chat.
  await page.getByRole("textbox").first().or(page.getByRole("button", { name: /Bot principal/ })).first().waitFor()
  await page.evaluate(() => window.dispatchEvent(new Event("atlas:open-marketplace")))
  await page.getByRole("tablist", { name: "Seções do marketplace" }).waitFor()
  await page.getByRole("tab", { name: SECTION_LABEL[section] }).click()
}

const SIZES = [
  { name: "390", viewport: { width: 390, height: 844 }, mobile: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, mobile: false },
] as const

for (const size of SIZES) {
  test.describe(`previews da página do marketplace (escuro, ${size.name}px)`, () => {
    test.skip(!OUT, "defina SKILLS_PREVIEW_DIR para gerar as capturas")
    test.use({ viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile })
    test.beforeEach(async ({ context }) => {
      await context.addInitScript(() => localStorage.setItem("theme", "dark"))
    })
    const shot = async (page: Page, name: string) => {
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
      await page.waitForTimeout(500)
      await page.screenshot({ path: `${OUT}/${size.name}-${name}.png` })
    }
    const extraBots = [
      { id: "bot-ana", name: "Ana", description: "Rotina e agenda" },
      { id: "bot-carlos", name: "Carlos", description: "Código e revisões" },
    ]
    const mock = (handler: MockHandler) => {
      const api = new MockAtlas({ botName: "Assistente", extraBots, connectors: { catalog: NATIVE, custom: [] } })
      api.handler = handler
      return api
    }

    test("abas: conectores, apps, agentes e habilidades", async ({ context, page }) => {
      await mock(withHandlers(catalogHandler(), composioHandler)).install(context)
      await openMarketplace(page)
      await page.getByText("Em destaque").waitFor()
      await shot(page, "01-aba-conectores")
      await page.getByRole("tab", { name: "Apps" }).click()
      await page.getByText("Linear").first().waitFor()
      await shot(page, "02-aba-apps")
      await page.getByRole("tab", { name: "Agentes" }).click()
      await page.getByText("Agentes prontos").waitFor()
      await shot(page, "03-aba-agentes")
      await page.getByRole("tab", { name: "Habilidades" }).click()
      await page.getByText("Habilidades da comunidade").waitFor()
      await shot(page, "04-aba-habilidades")
    })

    test("detalhes: habilidade e agente, voltar do navegador", async ({ context, page }) => {
      await mock(withHandlers(catalogHandler(), composioHandler)).install(context)
      await openMarketplace(page, "habilidades")
      await page.getByRole("button", { name: "Ver detalhes de roblox" }).click()
      await page.getByRole("heading", { name: "Instruções" }).waitFor()
      await shot(page, "05-habilidade-detalhe")
      await page.goBack()
      await page.getByText("Habilidades da comunidade").waitFor()
      await page.getByRole("tab", { name: "Agentes" }).click()
      await page.getByRole("button", { name: "Ver detalhes de Dev Roblox" }).click()
      await page.getByRole("heading", { name: "Conectores recomendados" }).waitFor()
      await shot(page, "06-agente-detalhe")
    })

    test("instalar: habilidade (escopo) e agente", async ({ context, page }) => {
      await mock(withHandlers(catalogHandler(), composioHandler)).install(context)
      await openMarketplace(page, "habilidades")
      await page.getByRole("button", { name: /^Instalar roblox/ }).click()
      await page.getByRole("radiogroup", { name: "Onde instalar" }).waitFor()
      await shot(page, "07-instalar-habilidade-escopo")
      await page.getByRole("button", { name: "Cancelar" }).click()
      await page.getByRole("tab", { name: "Agentes" }).click()
      await page.getByRole("button", { name: "Instalar Dev Roblox" }).click()
      await page.getByLabel("Nome").waitFor()
      await shot(page, "08-instalar-agente")
      await page.getByRole("button", { name: "Mudar aparência" }).click()
      await page.getByText("Rotinas sugeridas (opcional)").evaluate((el) => el.scrollIntoView({ block: "center" }))
      await shot(page, "09-instalar-agente-aparencia-e-rotinas")
    })

    test("atualização disponível e cópia editada", async ({ context, page }) => {
      const installs = [{ id: "d1", botId: null, name: "roblox", version: "1.0.0", edited: true, updateAvailable: true }]
      await mock(withHandlers(catalogHandler({ installs, version: "1.1.0", conflict: true }), composioHandler)).install(context)
      await openMarketplace(page, "habilidades")
      await page.getByText("Habilidades da comunidade").waitFor()
      await shot(page, "10-habilidades-atualizacao-disponivel")
      await page.getByRole("button", { name: "Ver detalhes de roblox" }).click()
      await page.getByText("Atualização disponível", { exact: true }).waitFor()
      await shot(page, "11-habilidade-detalhe-atualizacao")
      await page.getByRole("button", { name: "Atualizar", exact: true }).first().click()
      await page.getByRole("radiogroup", { name: "Onde instalar" }).waitFor()
      await page.getByRole("button", { name: "Atualizar", exact: true }).last().click()
      await page.getByText("Atualizar e perder minhas mudanças").waitFor()
      await shot(page, "12-atualizacao-copia-editada")
    })

    test("publicar (folha sobre as Configurações)", async ({ context, page }) => {
      const api = new MockAtlas({ botName: "Assistente", skills: [{ name: "minha-skill", description: "Resume o dia a partir das tarefas e reuniões." }] })
      api.handler = ({ method, path }) => {
        if (method === "GET" && path === "/v1/skills/sk-0") {
          return {
            body: {
              skill: {
                id: "sk-0",
                botId: null,
                name: "minha-skill",
                description: "Resume o dia a partir das tarefas e reuniões.",
                body: "1. Liste as tarefas concluídas. 2. Resuma as reuniões.",
                tools: [],
                enabled: true,
                createdBy: "user",
                status: "active",
                revision: 1,
                createdAt: "2026-10-15T12:00:00.000Z",
                updatedAt: "2026-10-15T12:00:00.000Z",
                source: null,
              },
            },
          }
        }
        if (method === "POST" && path === "/v1/skills/sk-0/publish") {
          return { body: { mode: "pr", url: "https://github.com/ali-ali18/agent-skills/pull/12", number: 12 } }
        }
        return undefined
      }
      await api.install(context)
      await page.goto("/?settings=habilidades")
      await page.getByRole("button", { name: "Publicar minha-skill no marketplace" }).waitFor({ timeout: 60_000 })
      await page.getByRole("button", { name: "Publicar minha-skill no marketplace" }).click()
      await page.getByLabel("O que mudou").waitFor()
      await page.getByLabel("Autor").fill("ali-ali18")
      await page.getByLabel("Tags").fill("produtividade, relatorio")
      await page.getByLabel("O que mudou").fill("Primeira versão: resume tarefas e reuniões do dia.")
      await shot(page, "13-publicar-formulario-sobre-configuracoes")
      await page.getByRole("button", { name: "Publicar no marketplace" }).last().click()
      await page.getByText("Pull request aberto").waitFor()
      await shot(page, "14-publicar-pr-aberto")
    })
  })
}
