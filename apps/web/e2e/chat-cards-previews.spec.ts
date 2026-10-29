import { test, type Page } from "@playwright/test"
import { frameInboundEmail, parseChartSpec, parsePageSpec } from "@workspace/shared"
import { MockAtlas, type MockHandler } from "./mock-api"

/**
 * Capturas (tema escuro; 1440 e 390) dos cartões do chat, para comparar antes/depois de mudar a "pele" deles.
 * Uma conversa mockada com mensagens persistidas (como o use-atlas-chat as restaura) e um recorte por grupo
 * (no máximo 3 itens por imagem). Só roda com CHAT_CARDS_PREVIEW_DIR (pasta de saída).
 * CHAT_CARDS_CHROMIUM_PATH aponta um Chromium já instalado (opcional).
 */
const OUT = process.env.CHAT_CARDS_PREVIEW_DIR
const CHROMIUM = process.env.CHAT_CARDS_CHROMIUM_PATH
if (CHROMIUM) test.use({ launchOptions: { executablePath: CHROMIUM } })

const SIZES = [
  { name: "desktop-1440", viewport: { width: 1440, height: 2400 }, mobile: false },
  { name: "mobile-390", viewport: { width: 390, height: 2400 }, mobile: true },
] as const

const chartSpec = (() => {
  const parsed = parseChartSpec({
    type: "line",
    title: "Receita e despesas em 2025",
    x: "mes",
    series: [{ key: "receita", label: "Receita" }, { key: "despesa", label: "Despesas" }],
    data: ["2025-01-01", "2025-02-01", "2025-03-01", "2025-04-01", "2025-05-01", "2025-06-01", "2025-07-01", "2025-08-01"].map((mes, i) => ({ mes, receita: 40000 + i * 4300 + (i % 3) * 1800, despesa: 30000 + i * 2900 })),
    unit: "BRL",
  })
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.spec
})()

const pageSpec = (() => {
  const parsed = parsePageSpec({
    v: 2,
    title: "Pedidos da semana",
    summary: "Receita acima da meta",
    palette: "grove",
    root: {
      type: "stack",
      children: [
        { type: "grid", props: { cols: 2 }, children: [
          { type: "stat", props: { label: "Receita", value: 120000, unit: "BRL", delta: { value: 8, kind: "percent", direction: "up", label: "vs meta" } } },
          { type: "stat", props: { label: "Pedidos", value: 42 } },
        ] },
        { type: "bar_list", props: { items: [{ label: "Sul", value: 5 }, { label: "Norte", value: 3, display: "3 mil" }] } },
      ],
    },
  })
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.spec
})()

type Seed = { id: string; role: string; content: string; source?: { kind: string; label: string; at: string } }
const card = (id: string, role: string, body: Record<string, unknown>): Seed => ({ id, role, content: JSON.stringify({ v: 1, kind: role, ...body }) })
const text = (id: string, role: "user" | "assistant", content: string): Seed => ({ id, role, content })

const PLAN = { title: "Organizar o fechamento do mês", steps: [{ text: "Ler as notas fiscais do Bling", kind: "read" }, { text: "Gerar a planilha de conciliação", kind: "write" }, { text: "Perguntar o que fazer com divergências", kind: "ask" }], needs: ["Acesso ao Bling"], risks: "Nenhum dado é alterado antes da sua aprovação." }
const CODE = "import pandas as pd\n\ndf = pd.read_csv('in/vendas.csv')\nmensal = df.groupby('mes')['total'].sum()\nprint(mensal.tail(3))"

/** Ordem = ordem na conversa. */
const SEEDS: Seed[] = [
  text("c01", "user", "Cria uma rotina que me manda um resumo das vendas toda segunda às 8h e me mostra um gráfico da receita."),
  text("c02", "assistant", "Combinado! Vou criar a rotina e já te mostro o gráfico de receita do ano."),
  card("c03", "routine", { action: "created", title: "Resumo de vendas", routineId: "r-1", triggerType: "cron", detail: "Resumo de vendas · toda segunda às 08:00" }),
  card("c04", "task-list", { runId: "run-1", items: [{ content: "Ler as vendas do mês", status: "completed" }, { content: "Calcular receita e despesas", status: "in_progress" }, { content: "Montar o painel", status: "pending" }] }),
  card("c05", "code-run", { callId: "call-1", code: CODE, status: "ok", durationMs: 1240, output: "mes\n2025-06    61750\n2025-07    58400\n2025-08    64100" }),
  card("c06", "code-run", { callId: "call-2", code: "df = pd.read_csv('in/nao-existe.csv')", status: "error", durationMs: 310, output: "FileNotFoundError: in/nao-existe.csv" }),
  card("c07", "chart", { chartId: "chart-1", spec: chartSpec }),
  card("c08", "page", { pageId: "page-1", revision: 1, title: "Pedidos da semana", action: "created", spec: pageSpec, sourceCount: 3 }),
  card("c09", "file", { artifactId: "art-1", filename: "conciliacao-outubro.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 48213, format: "xlsx", version: 2 }),
  card("c10", "file", { artifactId: "art-2", filename: "contrato-fornecedor.pdf", mime: "application/pdf", size: 912340, format: "pdf", version: 1, origin: "user" }),
  { id: "c11", role: "user", content: frameInboundEmail({ from: "Marina Souza <marina@exemplo.com>", subject: "Dividir o grupo de Estatística?", threadId: "th-1", body: "Oi! Posso dividir o grupo de Estatística em dois? Me diz até sexta, por favor." }), source: { kind: "email", label: "E-mail", at: "2026-10-15T12:00:30.000Z" } },
  { id: "c12", role: "Pesquisou na web", content: "preço do dólar hoje" },
  card("c13", "skill", { action: "created", title: "Conciliação bancária", capabilityKey: "conciliacao-bancaria", learned: true, skillId: "sk-1" }),
  card("c14", "skill", { action: "updated", title: "Resumo semanal", capabilityKey: "resumo-semanal", versionNumber: 3, detail: "Passou a incluir as despesas." }),
  card("c15", "compaction", { before: 84200, after: 9100, summary: "Conversa sobre o fechamento do mês: o Bling já foi conectado, a rotina de segunda foi criada e falta decidir o que fazer com 3 divergências." }),
  card("c16", "revised-draft", { text: "A receita de agosto foi de R$ 64.100, acima de julho.", reason: "conferência" }),
  text("c17", "assistant", "A receita de agosto foi de R$ 64.100 (+9,8% sobre julho). Corrigi um número que eu tinha citado errado."),
  card("c18", "confirm", { confirmId: "cf-1", title: "Enviar o resumo para a Marina?", description: "Vou mandar um e-mail para marina@exemplo.com com o resumo das vendas.", status: "pending", confirmLabel: "Enviar", cancelLabel: "Agora não" }),
  card("c19", "confirm", { confirmId: "cf-2", title: "Criar o evento \"Reunião com fornecedor\"?", description: "Quinta, 14h, no Google Agenda.", status: "approved", confirmLabel: "Criar", cancelLabel: "Cancelar", outcome: { ok: true, detail: "Evento criado para quinta às 14h." } }),
  card("c20", "confirm", { confirmId: "cf-3", title: "Apagar 12 e-mails antigos?", description: "Só os de promoção com mais de 90 dias.", status: "rejected", confirmLabel: "Apagar", cancelLabel: "Cancelar" }),
  card("c21", "confirm", { confirmId: "cf-4", title: "Plano", status: "pending", confirmLabel: "Aprovar plano", cancelLabel: "Cancelar", plan: PLAN }),
  card("c22", "confirm", { confirmId: "cf-5", title: "Plano", status: "approved", confirmLabel: "Aprovar plano", cancelLabel: "Cancelar", plan: PLAN }),
  card("c23", "confirm", { confirmId: "cf-6", title: "Rodar comando", status: "pending", confirmLabel: "Permitir", cancelLabel: "Recusar", alwaysLabel: "Sempre permitir", devApproval: { kind: "command", command: "pnpm exec turbo typecheck", cwd: "/workspace/app", repo: "acme/loja", branch: "feat/frete", reason: "Conferir se o código compila." } }),
  card("c24", "login", { loginId: "lg-1", site: "Portal do fornecedor", url: "https://portal.exemplo.com/login", status: "pending" }),
  card("c25", "login", { loginId: "lg-2", site: "GitHub", url: "https://github.com", status: "pending", connector: { kind: "native", id: "github", name: "GitHub", description: "Repositórios, issues e pull requests", icon: "/connectors/github.svg" } }),
  card("c26", "login", { loginId: "lg-3", site: "GitHub", url: "https://github.com", status: "done", connector: { kind: "native", id: "github", name: "GitHub", description: "Repositórios, issues e pull requests", icon: "/connectors/github.svg" } }),
  card("c27", "questionnaire", { questionnaireId: "q-1", title: "Antes de montar o painel", status: "pending", items: [{ name: "periodo", prompt: "Qual período você quer ver?", choices: [{ value: "semana", label: "Última semana" }, { value: "mes", label: "Último mês" }, { value: "ano", label: "Ano todo" }] }, { name: "obs", prompt: "Alguma observação?", input: { label: "Observação", placeholder: "Opcional" } }] }),
  card("c28", "routine-proposal", { proposalId: "rp-1", mode: "suggest", status: "pending", spec: { name: "Conferir pedidos atrasados", prompt: "Check late orders and report only if there is news.", schedule: "0 9 * * 1-5", timezone: "America/Sao_Paulo" } }),
  card("c29", "routine-proposal", { proposalId: "rp-2", mode: "auto", status: "accepted", routineId: "r-2", spec: { name: "Acompanhar resposta da Marina", prompt: "Check for a reply.", everyMinutes: 180, timezone: "America/Sao_Paulo" } }),
  card("c30", "bot-proposal", { proposalId: "bp-1", status: "pending", name: "Financeiro", description: "Cuida de contas a pagar e a receber e do fechamento do mês.", snippet: "Contas e fechamento", color: "#FF6700", shape: "blob", model: null, skills: [], firstTask: "Fazer o fechamento de outubro." }),
  card("c31", "subagents", { groupId: "g-1", tasks: [{ taskIndex: 0, title: "Notas fiscais", goal: "Listar as notas de outubro", status: "ok", summary: "42 notas encontradas.", toolsUsed: ["bling"] }, { taskIndex: 1, title: "Boletos", goal: "Conferir boletos vencidos", status: "partial", summary: "Só 8 de 10 conferidos.", toolsUsed: ["bling"] }] }),
  card("c32", "tool-budget", { tool: "bling_list_nfes", from: 20, to: 40, connectorName: "Bling" }),
  card("c33", "provider-fallback", { from: "modelo-a", to: "modelo-b", message: "O modelo principal ficou indisponível; continuei com o reserva." }),
]

/** Grupos por imagem: no máximo 3 itens (balões e cartões) cada. */
const GROUPS: Array<[string, string[]]> = [
  ["conversa-e-rotina-criada", ["c01", "c02", "c03"]],
  ["lista-de-tarefas", ["c04"]],
  ["codigo-ok-e-erro", ["c05", "c06"]],
  ["grafico", ["c07"]],
  ["painel", ["c08"]],
  ["arquivos", ["c09", "c10"]],
  ["email-recebido", ["c11"]],
  ["skills", ["c13", "c14"]],
  ["compactacao-e-resposta", ["c15", "c17"]],
  ["confirmacoes-pendente-aprovada-recusada", ["c18", "c19", "c20"]],
  ["plano-pendente-e-aprovado", ["c21", "c22"]],
  ["aprovacao-de-comando", ["c23"]],
  ["login-site", ["c24"]],
  ["conector-pendente-e-conectado", ["c25", "c26"]],
  ["questionario", ["c27"]],
  ["rotinas-propostas", ["c28", "c29"]],
  ["proposta-de-agente", ["c30"]],
  ["subagentes", ["c31"]],
  ["marcadores-limite-e-fallback", ["c32", "c33"]],
]

/** O mock base não conhece a lista de painéis da Biblioteca (devolve `{}`): lista vazia. */
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
  test.describe(`previews dos cartões do chat (escuro, ${size.name})`, () => {
    test.skip(!OUT, "defina CHAT_CARDS_PREVIEW_DIR para gerar as capturas")
    test.use({ viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile })
    test.beforeEach(async ({ context }) => {
      await context.addInitScript(() => localStorage.setItem("theme", "dark"))
    })

    test("cartões persistidos", async ({ context, page }) => {
      test.setTimeout(240_000)
      const api = new MockAtlas({ history: [] })
      const conversationId = "conv-e2e"
      const base = Date.parse("2026-10-15T12:00:00.000Z")
      SEEDS.forEach((seed, index) => {
        api.messages.push({ id: seed.id, conversationId, role: seed.role, content: seed.content, createdAt: new Date(base + index * 1000).toISOString(), ...(seed.source ? { source: seed.source } : {}) })
      })
      api.handler = libraryHandler
      await api.install(context)
      await openChat(page)
      await page.locator(`[data-message-id="c01"]`).waitFor()
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
      await page.waitForTimeout(1500)
      const rowIds = await page.locator("[data-message-id]").evaluateAll((els) => els.map((el) => el.getAttribute("data-message-id")))
      console.log(`[chat-cards] ${size.name}: linhas visíveis ${rowIds.join(",")}`)

      let n = 0
      for (const [name, ids] of GROUPS) {
        n += 1
        const rows = ids.map((id) => page.locator(`[data-message-id="${id}"]`).first())
        if ((await rows[0]!.count()) === 0) {
          console.log(`[chat-cards] ${size.name}: grupo "${name}" sem linha, pulado`)
          continue
        }
        await rows[0]!.scrollIntoViewIfNeeded()
        await page.waitForTimeout(250)
        const boxes = []
        for (const row of rows) {
          if ((await row.count()) === 0) continue // ex.: rascunho revisado e atividade de ferramenta não aparecem na conversa
          const box = await row.boundingBox()
          if (box) boxes.push(box)
        }
        if (boxes.length === 0) continue
        const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 12)
        const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 12)
        const x1 = Math.min(size.viewport.width, Math.max(...boxes.map((b) => b.x + b.width)) + 12)
        const y1 = Math.min(size.viewport.height, Math.max(...boxes.map((b) => b.y + b.height)) + 12)
        await page.screenshot({ path: `${OUT}/${String(n).padStart(2, "0")}-${name}-${size.name}.png`, clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } })
      }
    })
  })
}
