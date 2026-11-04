import { test, type Page } from "@playwright/test"
import { MockAtlas, type MockHandler } from "./mock-api"

/**
 * Prévias (tema escuro; 1440 e 390) dos cartões que esperam o dono do motor v3 (PR8d): login/VM com Pular · Terminei ·
 * Assumir e os selos, questionário com Pular, aprovação genérica e rascunho, cartão do limite e "Volto às". Uma conversa
 * mockada por cenário (só um pedido de aprovação fica pendente por conversa) e no máximo 3 itens por imagem.
 * Só roda com OWNER_WAIT_PREVIEW_DIR (pasta de saída); OWNER_WAIT_CHROMIUM_PATH aponta um Chromium instalado.
 */
const OUT = process.env.OWNER_WAIT_PREVIEW_DIR
const CHROMIUM = process.env.OWNER_WAIT_CHROMIUM_PATH
if (CHROMIUM) test.use({ launchOptions: { executablePath: CHROMIUM } })
test.use({ timezoneId: "America/Sao_Paulo", locale: "pt-BR" })

const SIZES = [
  { name: "desktop-1440", viewport: { width: 1440, height: 2000 }, mobile: false },
  { name: "mobile-390", viewport: { width: 390, height: 2000 }, mobile: true },
] as const

/** Hoje às 14:30 em São Paulo (17:30 UTC): o prazo e o retorno aparecem como "às 14:30". */
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" })
const AT_1430 = `${today}T17:30:00.000Z`

type Seed = { id: string; role: string; content: string }
const card = (id: string, role: string, body: Record<string, unknown>): Seed => ({ id, role, content: JSON.stringify({ v: 1, kind: role, ...body }) })
const text = (id: string, role: "user" | "assistant", content: string): Seed => ({ id, role, content })

const SCENARIOS: Array<{ name: string; seeds: Seed[]; groups: Array<[string, string[]]> }> = [
  {
    name: "handoff",
    seeds: [
      text("u1", "user", "Resume o vídeo pelo Gemini e monta um slide."),
      card("h1", "login", { loginId: "lg-1", site: "gemini.google.com", url: "https://gemini.google.com/app", status: "pending", ownerWait: true, deadlineAt: AT_1430 }),
      card("h2", "login", { loginId: "lg-2", site: "portal.fornecedor.com", url: "https://portal.fornecedor.com", status: "done", outcome: "takeover", ownerWait: true }),
      card("h3", "login", { loginId: "lg-3", site: "app.banco.com", url: "https://app.banco.com", status: "done", outcome: "skipped_timeout", ownerWait: true }),
      card("h4", "login", { loginId: "lg-4", site: "notion.so", url: "https://notion.so", status: "done", outcome: "ignored", ownerWait: true }),
    ],
    groups: [["01-handoff-pendente-com-prazo", ["h1"]], ["02-handoff-selos", ["h2", "h3", "h4"]]],
  },
  {
    name: "limite-e-volto",
    seeds: [
      text("u1", "user", "Confere os pedidos atrasados e me avisa."),
      card("l1", "confirm", { confirmId: "confirm-limit1-run-r1", title: "Cheguei no limite de 40 passos. Continuo?", description: "Guardei onde parei. Continuar retoma daqui com mais 40 passos; Agora não encerra e conta o que ficou feito.", status: "pending", confirmLabel: "Continuar", cancelLabel: "Agora não", ownerCard: "step-limit", limitProgress: { steps: 40, costUsd: 0.18, tasksDone: ["Ler os pedidos de outubro no Bling", "Separar os atrasados por cliente"], tasksTotal: 4 } }),
      text("a1", "assistant", "O deploy ainda está rodando. Volto às 14:30 para conferir."),
      card("r1", "return", { returnId: "ret-1", at: AT_1430, reason: "conferir o deploy", status: "pending" }),
      card("r2", "return", { returnId: "ret-2", at: `${today}T21:00:00.000Z`, reason: "ver a resposta da Marina", status: "cancelled" }),
    ],
    groups: [["03-limite-continuo", ["l1"]], ["04-volto-as", ["a1", "r1", "r2"]]],
  },
  {
    name: "rascunho",
    seeds: [
      text("a0", "assistant", "Preparei o resumo das vendas para a Ana; falta só você liberar o envio."),
      card("d1", "confirm", { confirmId: "confirm-toolab12cd34-run-routine", title: "Enviar esta mensagem?", description: "Resumo de vendas de outubro para a Ana.\n\nto: ana@cliente.com\nsubject: Vendas de outubro\nbody: Oi Ana, segue o resumo: R$ 64.100 em outubro (+9,8%).", status: "pending", confirmLabel: "Permitir", cancelLabel: "Agora não", ownerCard: "draft" }),
    ],
    groups: [["05-rascunho-da-rotina", ["a0", "d1"]]],
  },
  {
    name: "aprovacao-e-questionario",
    seeds: [
      text("u1", "user", "Monta o painel de vendas e compartilha com o time."),
      card("q1", "questionnaire", { questionnaireId: "questionnaire-run-q", title: "Antes de montar o painel", status: "pending", ownerWait: true, deadlineAt: AT_1430, items: [{ name: "periodo", prompt: "Qual período você quer ver?", choices: [{ value: "semana", label: "Última semana" }, { value: "mes", label: "Último mês" }, { value: "ano", label: "Ano todo" }] }] }),
      card("p1", "confirm", { confirmId: "confirm-toolcd34ab12-run-a", title: "Criar um link público do painel?", description: "pageId: pg-1\nexpiresInDays: 7", status: "pending", confirmLabel: "Permitir", cancelLabel: "Agora não", ownerCard: "approval", deadlineAt: AT_1430 }),
    ],
    groups: [["06-questionario-com-pular", ["q1"]], ["07-aprovacao-com-prazo", ["p1"]]],
  },
  {
    // Antes/depois da casca nova (ChatCard): cartões antigos que todo motor usa.
    name: "antigos",
    seeds: [
      text("u1", "user", "Manda o resumo das vendas para a Marina."),
      card("o1", "confirm", { confirmId: "cf-1", title: "Enviar o resumo para a Marina?", description: "Vou mandar um e-mail para marina@exemplo.com com o resumo das vendas.", status: "pending", confirmLabel: "Enviar", cancelLabel: "Agora não" }),
      card("o2", "task-list", { runId: "run-1", items: [{ content: "Ler as vendas do mês", status: "completed" }, { content: "Calcular receita e despesas", status: "completed" }, { content: "Montar o painel", status: "completed" }] }),
      card("o3", "login", { loginId: "lg-c", site: "Notion", url: "https://notion.so", status: "pending", connector: { kind: "native", id: "notion", name: "Notion", description: "Páginas, bancos de dados e comentários do seu workspace", icon: "/connectors/notion.svg" } }),
    ],
    groups: [["09-antigos-aprovacao-e-tarefas", ["o1", "o2"]], ["10-antigos-conector", ["o3"]]],
  },
  {
    // Pedido do dono (04/11): recusar é interno. O clique ("cancela isso") e a nota para o modelo não viram balão.
    name: "recusado-so-selo",
    seeds: [
      text("u1", "user", "Compartilha o painel de vendas com o time."),
      card("p2", "confirm", { confirmId: "confirm-toolee11ff22-run-b", title: "Criar um link público do painel?", description: "pageId: pg-1", status: "rejected", confirmLabel: "Permitir", cancelLabel: "Agora não", ownerCard: "approval", outcome: { ok: false, detail: "Agora não" } }),
      text("u2", "user", "cancela isso"),
      { id: "n1", role: "system", content: '[runtime] Owner declined: "Criar um link público do painel". It was not done.' },
      card("p3", "confirm", { confirmId: "confirm-tool33445566-run-c", title: "Enviar esta mensagem?", description: "to: ana@cliente.com", status: "rejected", confirmLabel: "Permitir", cancelLabel: "Agora não", ownerCard: "approval", outcome: { ok: false, detail: "Tempo esgotado · segui sem isso" } }),
    ],
    groups: [["08-recusado-so-selo-sem-balao", ["u1", "p2", "p3"]]],
  },
]

const libraryHandler: MockHandler = ({ method, path }) =>
  method === "GET" && /^\/v1\/bots\/[^/]+\/pages$/.test(path)
    ? { body: { items: [] } }
    : method === "GET" && path === "/v1/usage"
      ? { body: { totals: { costUsd: 0, runs: 0, inputTokens: 0, outputTokens: 0 }, bots: [], models: [], days: [] } }
      : undefined

async function openChat(page: Page) {
  await page.goto("/")
  const bot = page.getByRole("button", { name: /Bot principal Atlas/ })
  try {
    await bot.waitFor({ timeout: 12_000 })
  } catch {
    await page.reload()
  }
  if (await page.getByRole("textbox", { name: /Mensagem para/ }).count() === 0) await bot.click()
  await page.getByRole("textbox", { name: /Mensagem para/ }).waitFor()
}

for (const size of SIZES) {
  test.describe(`prévias do esperar o dono (escuro, ${size.name})`, () => {
    test.skip(!OUT, "defina OWNER_WAIT_PREVIEW_DIR para gerar as capturas")
    test.use({ viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile })
    test.beforeEach(async ({ context }) => {
      await context.addInitScript(() => localStorage.setItem("theme", "dark"))
    })

    for (const scenario of SCENARIOS) {
      test(scenario.name, async ({ context, page }) => {
        test.setTimeout(180_000)
        const api = new MockAtlas({ history: [] })
        const conversationId = "conv-e2e"
        const base = Date.now() - 60_000
        scenario.seeds.forEach((seed, index) => {
          api.messages.push({ id: seed.id, conversationId, role: seed.role, content: seed.content, createdAt: new Date(base + index * 1000).toISOString() })
        })
        api.handler = libraryHandler
        await api.install(context)
        await openChat(page)
        await page.locator(`[data-message-id="${scenario.seeds[0]!.id}"]`).waitFor()
        await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
        await page.waitForTimeout(1200)
        for (const [name, ids] of scenario.groups) {
          const rows = ids.map((id) => page.locator(`[data-message-id="${id}"]`).first())
          if ((await rows[0]!.count()) === 0) {
            console.log(`[owner-wait] ${size.name}: grupo "${name}" sem linha, pulado`)
            continue
          }
          await rows[0]!.scrollIntoViewIfNeeded()
          await page.waitForTimeout(250)
          const boxes = []
          for (const row of rows) {
            if ((await row.count()) === 0) continue
            const box = await row.boundingBox()
            if (box) boxes.push(box)
          }
          if (boxes.length === 0) continue
          const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 12)
          const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 12)
          const x1 = Math.min(size.viewport.width, Math.max(...boxes.map((b) => b.x + b.width)) + 12)
          const y1 = Math.min(size.viewport.height, Math.max(...boxes.map((b) => b.y + b.height)) + 12)
          await page.screenshot({ path: `${OUT}/${name}-${size.name}.png`, clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } })
        }
      })
    }
  })
}
