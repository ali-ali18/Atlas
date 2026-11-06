import { test, type Page } from "@playwright/test"
import type { AgentV4Event } from "@workspace/shared"
import { MockAtlas, type MockHandler } from "./mock-api"

/**
 * Capturas (tema escuro; 1440 e 390) dos cards do motor v4: aprovação, "isso é com você", pergunta do bot e
 * recibo. A conversa mockada tem os cards gravados (`role` = tipo do evento, como o use-atlas-chat os restaura)
 * e um recorte por grupo, no máximo 3 itens por imagem. Só roda com AGENT_CARDS_PREVIEW_DIR (pasta de saída).
 * AGENT_CARDS_CHROMIUM_PATH aponta um Chromium já instalado (opcional).
 */
const OUT = process.env.AGENT_CARDS_PREVIEW_DIR
const CHROMIUM = process.env.AGENT_CARDS_CHROMIUM_PATH
if (CHROMIUM) test.use({ launchOptions: { executablePath: CHROMIUM } })

const SIZES = [
  { name: "desktop-1440", viewport: { width: 1440, height: 2000 }, mobile: false },
  { name: "mobile-390", viewport: { width: 390, height: 2400 }, mobile: true },
] as const

type Seed = { id: string; role: string; content: string }
const text = (id: string, role: "user" | "assistant", content: string): Seed => ({ id, role, content })
const card = (id: string, event: AgentV4Event): Seed => ({ id, role: event.type, content: JSON.stringify(event) })

const SEEDS: Seed[] = [
  text("a01", "user", "Manda o orçamento para a Ana e compra o livro de estatística que ela indicou."),
  text("a02", "assistant", "Já deixei o e-mail pronto e achei o livro. Preciso do seu ok antes de enviar e de pagar."),
  card("a03", { type: "approval_request", requestId: "req-1", callId: "call-1", toolName: "send_email", effect: "send", args: { to: "ana@exemplo.com", subject: "Orçamento de novembro", body: "Oi, Ana! Segue o orçamento de novembro em anexo." }, riskFacts: { recipients: ["ana@exemplo.com"], externalRecipients: ["ana@exemplo.com"] }, runId: "run-1" }),
  card("a04", { type: "approval_request", requestId: "req-2", callId: "call-2", toolName: "checkout", effect: "money", args: { item: "Estatística Básica, 9ª edição", card: "Cartão final 4242" }, riskFacts: { amount: 89.9, currency: "BRL", merchant: "Livraria Exemplo", irreversible: true }, runId: "run-1" }),
  card("a05", { type: "approval_request", requestId: "req-3", callId: "call-3", toolName: "share_page", effect: "public_link", args: { title: "Pedidos da semana" }, riskFacts: { target: "Pedidos da semana" }, runId: "run-1" }),
  card("a06", { type: "handoff_request", callId: "call-4", message: "1. Abra o app do banco\n2. Toque em Pix > Aprovar pendentes\n3. Confirme o pagamento de R$ 89,90 para a Livraria Exemplo", runId: "run-1" }),
  card("a07", { type: "ask_owner", cardId: "ask-1", question: "O livro tem capa comum e capa dura (R$ 30 a mais). Qual prefere?", choices: [{ value: "comum", label: "Capa comum" }, { value: "dura", label: "Capa dura", description: "R$ 30 a mais" }], runId: "run-1" }),
  card("a08", { type: "receipt", id: "call-1", name: "send_email", what: "E-mail enviado para ana@exemplo.com", where: "Gmail", url: "https://mail.example.com/m/1", runId: "run-1" }),
  card("a09", { type: "receipt", id: "call-5", name: "create_event", what: "Evento criado: entrega do livro", where: "Google Agenda", runId: "run-1" }),
]

/** Grupos por imagem: no máximo 3 itens cada. */
const GROUPS: Array<[string, string[]]> = [
  ["aprovacao-envio-e-pagamento", ["a03", "a04"]],
  ["aprovacao-decidida-e-handoff", ["a05", "a06"]],
  ["pergunta-e-recibos", ["a07", "a08", "a09"]],
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
  test.describe(`previews dos cards do motor v4 (escuro, ${size.name})`, () => {
    test.skip(!OUT, "defina AGENT_CARDS_PREVIEW_DIR para gerar as capturas")
    test.use({ viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile, locale: "pt-BR" })
    test.beforeEach(async ({ context }) => {
      await context.addInitScript(() => {
        localStorage.setItem("theme", "dark")
        // O link público já foi aprovado neste aparelho: o card mostra só o selo.
        localStorage.setItem("atlas:agent-card-decisions", JSON.stringify([["approval_request|run-1|req-3", "approved"]]))
      })
    })

    test("cards gravados", async ({ context, page }) => {
      test.setTimeout(240_000)
      const api = new MockAtlas({ history: [] })
      const conversationId = "conv-e2e"
      const base = Date.parse("2026-11-06T12:00:00.000Z")
      SEEDS.forEach((seed, index) => {
        api.messages.push({ id: seed.id, conversationId, role: seed.role, content: seed.content, createdAt: new Date(base + index * 1000).toISOString() })
      })
      api.handler = libraryHandler
      await api.install(context)
      await openChat(page)
      await page.locator(`[data-message-id="a01"]`).waitFor()
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
      await page.waitForTimeout(1500)

      let n = 0
      for (const [name, ids] of GROUPS) {
        n += 1
        const rows = ids.map((id) => page.locator(`[data-message-id="${id}"]`).first())
        if ((await rows[0]!.count()) === 0) throw new Error(`grupo "${name}" sem linha na tela`)
        await rows[0]!.scrollIntoViewIfNeeded()
        await page.waitForTimeout(250)
        const boxes = []
        for (const row of rows) {
          const box = await row.boundingBox()
          if (box) boxes.push(box)
        }
        const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 12)
        const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 12)
        const x1 = Math.min(size.viewport.width, Math.max(...boxes.map((b) => b.x + b.width)) + 12)
        const y1 = Math.min(size.viewport.height, Math.max(...boxes.map((b) => b.y + b.height)) + 12)
        await page.screenshot({ path: `${OUT}/${String(n).padStart(2, "0")}-${name}-${size.name}.png`, clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } })
      }
    })
  })
}
