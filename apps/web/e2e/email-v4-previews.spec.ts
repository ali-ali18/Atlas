import { test, type Page } from "@playwright/test"
import { MockAtlas, type MockHandler } from "./mock-api"

/**
 * Capturas (tema escuro, desktop 1440 e celular 390) dos cartões de e-mail do motor v4 (F7.1): triagem (precisa de ação com
 * prazo e quem pede, só para saber, ignorar recolhido), triagem sem ação e rascunhos (resposta no Gmail, caixa do bot que
 * só vive no cartão, texto longo recolhido e aberto). Dados falsos, domínios .test. No máximo 3 blocos por imagem. Só roda com
 * EMAIL_V4_PREVIEW_DIR (pasta de saída). EMAIL_V4_CHROMIUM_PATH aponta um Chromium já instalado.
 */
const OUT = process.env.EMAIL_V4_PREVIEW_DIR
const CHROMIUM = process.env.EMAIL_V4_CHROMIUM_PATH
if (CHROMIUM) test.use({ launchOptions: { executablePath: CHROMIUM } })

const SIZES = [
  { name: "desktop-1440", viewport: { width: 1440, height: 2400 }, mobile: false },
  { name: "mobile-390", viewport: { width: 390, height: 2400 }, mobile: true },
] as const

type Seed = { id: string; role: string; content: string }
const card = (id: string, role: string, body: Record<string, unknown>): Seed => ({ id, role, content: JSON.stringify({ v: 1, kind: role, ...body }) })
const text = (id: string, role: "user" | "assistant", content: string): Seed => ({ id, role, content })

const LONG = Array.from({ length: 14 }, (_, i) => `Linha ${i + 1}: o orçamento inclui o item ${i + 1}, com entrega em até 10 dias úteis e garantia de 12 meses.`).join("\n")

const SEEDS: Seed[] = [
  text("e01", "user", "O que tem de importante no meu e-mail?"),
  text("e02", "assistant", "Duas mensagens pedem ação, a mais próxima vence quinta."),
  card("e03", "email-triage", {
    cardId: "run-1:email-triage:a1",
    items: [
      { id: "g1", source: "gmail", category: "needs_action", subject: "Orçamento para aprovar", summary: "Pede o seu ok no orçamento do novo servidor.", requester: "Ana Souza", from: "ana@empresa.test", deadline: "2026-11-12" },
      { id: "g2", source: "gmail", category: "needs_action", subject: "Contrato de aluguel", summary: "Precisa da assinatura até o fim da tarde de sexta.", from: "imobiliaria@aluguel.test", deadline: "2026-11-13T17:00:00-03:00" },
      { id: "g3", source: "gmail", category: "needs_action", subject: "Dúvida sobre o prazo do projeto", summary: "Pergunta se a entrega de dezembro está mantida." },
      { id: "g4", source: "gmail", category: "fyi", subject: "Relatório mensal publicado", summary: "O relatório de outubro já está disponível no painel.", from: "ops@empresa.test" },
      { id: "g5", source: "gmail", category: "ignore", subject: "Black Friday chegou", summary: "Promoção de uma loja." },
      { id: "g6", source: "gmail", category: "ignore", subject: "Seu pedido foi enviado", summary: "Aviso automático de envio." },
    ],
  }),
  text("e04", "user", "E na caixa do bot?"),
  card("e05", "email-triage", { cardId: "run-2:email-triage:b2", items: [{ id: "t7", source: "bot", category: "fyi", subject: "Obrigado pelo atendimento", summary: "Cliente agradeceu a resposta de ontem.", from: "cliente@fora.test" }] }),
  text("e06", "user", "Responde a Ana aprovando o orçamento."),
  card("e07", "email-draft", { cardId: "run-3:email-draft:c3", source: "gmail", to: ["ana@empresa.test"], subject: "Re: Orçamento para aprovar", body: "Oi, Ana,\n\nAprovado. Pode seguir com o servidor novo e me mandar a nota quando fechar.\n\nObrigado!", reply: true, saved: true }),
  text("e08", "user", "Escreve para o cliente com o preço do plano anual."),
  card("e09", "email-draft", { cardId: "run-4:email-draft:d4", source: "bot", to: ["cliente@fora.test"], subject: "Preço do plano anual", body: "Olá! O plano anual custa R$ 1.200,00 à vista ou 12x de R$ 110,00. Posso mandar o contrato quando você quiser.", saved: false }),
  card("e10", "email-draft", { cardId: "run-5:email-draft:e5", source: "gmail", to: ["time@empresa.test", "fin@empresa.test"], cc: ["diretoria@empresa.test"], subject: "Resumo do orçamento", body: LONG, saved: true }),
]

const GROUPS: Array<[string, string[]]> = [
  ["triagem-com-prazo", ["e01", "e02", "e03"]],
  ["triagem-sem-acao", ["e04", "e05"]],
  ["rascunho-resposta-gmail", ["e06", "e07"]],
  ["rascunho-caixa-do-bot", ["e08", "e09"]],
  ["rascunho-longo-recolhido", ["e10"]],
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
  if ((await page.getByRole("textbox", { name: /Mensagem para/ }).count()) === 0) await bot.click()
  await page.getByRole("textbox", { name: /Mensagem para/ }).waitFor()
}


for (const size of SIZES) {
  test.describe(`previews dos cartões de e-mail (escuro, ${size.name})`, () => {
    test.skip(!OUT, "defina EMAIL_V4_PREVIEW_DIR para gerar as capturas")
    test.use({ viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile, locale: "pt-BR" })
    test.beforeEach(async ({ context }) => {
      await context.addInitScript(() => localStorage.setItem("theme", "dark"))
    })

    test("cartões persistidos", async ({ context, page }) => {
      test.setTimeout(240_000)
      const api = new MockAtlas({ history: [] })
      const conversationId = "conv-e2e"
      const base = Date.parse("2026-11-07T12:00:00.000Z")
      SEEDS.forEach((seed, index) => {
        api.messages.push({ id: seed.id, conversationId, role: seed.role, content: seed.content, createdAt: new Date(base + index * 1000).toISOString() })
      })
      api.handler = libraryHandler
      await api.install(context)
      await openChat(page)
      await page.locator(`[data-message-id="e01"]`).waitFor()
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
      await page.waitForTimeout(2000)

      let n = 0
      for (const [name, ids] of GROUPS) {
        n += 1
        const rows = ids.map((id) => page.locator(`[data-message-id="${id}"]`).first())
        if ((await rows[0]!.count()) === 0) {
          console.log(`[email-v4] ${size.name}: grupo "${name}" sem linha, pulado`)
          continue
        }
        await rows[0]!.scrollIntoViewIfNeeded()
        await page.waitForTimeout(400)
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
        await page.screenshot({ path: `${OUT}/${String(n).padStart(2, "0")}-${name}-${size.name}.png`, clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } })
      }

      // Abre o que nasce recolhido ("Pode ignorar" e o texto longo do rascunho) e captura de novo: aberto mostra tudo.
      for (const [name, id, toggle] of [["triagem-ignorar-aberto", "e03", /Ver tudo \(2\)/], ["rascunho-longo-aberto", "e10", /Ler o texto/]] as const) {
        const row = page.locator(`[data-message-id="${id}"]`).first()
        if ((await row.count()) === 0) continue
        await row.scrollIntoViewIfNeeded()
        await row.getByText(toggle).first().click()
        await page.waitForTimeout(500)
        const box = await row.boundingBox()
        if (!box) continue
        n += 1
        await page.screenshot({ path: `${OUT}/${String(n).padStart(2, "0")}-${name}-${size.name}.png`, clip: { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 12), width: Math.min(size.viewport.width, box.width + 24), height: Math.min(size.viewport.height - Math.max(0, box.y - 12), box.height + 24) } })
      }
    })
  })
}
