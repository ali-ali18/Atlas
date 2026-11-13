import { test, type Page } from "@playwright/test"
import { MockAtlas, type MockHandler } from "./mock-api"

/**
 * Capturas (tema escuro, desktop 1440 e celular 390) dos cartões do calendário e do Plano do dia: evento criado (com convite e
 * conflito), evento alterado, lista do dia, dia livre, Plano do dia completo e Plano do dia com fonte em falha (e login
 * expirado). Dados falsos; no máximo 3 blocos por imagem. Só roda com CALENDAR_BRIEF_PREVIEW_DIR (pasta de saída).
 * CALENDAR_BRIEF_CHROMIUM_PATH aponta um Chromium já instalado.
 */
const OUT = process.env.CALENDAR_BRIEF_PREVIEW_DIR
const CHROMIUM = process.env.CALENDAR_BRIEF_CHROMIUM_PATH
if (CHROMIUM) test.use({ launchOptions: { executablePath: CHROMIUM } })

const SIZES = [
  { name: "desktop-1440", viewport: { width: 1440, height: 2400 }, mobile: false },
  { name: "mobile-390", viewport: { width: 390, height: 2400 }, mobile: true },
] as const

type Seed = { id: string; role: string; content: string }
const card = (id: string, role: string, body: Record<string, unknown>): Seed => ({ id, role, content: JSON.stringify({ v: 1, kind: role, ...body }) })
const text = (id: string, role: "user" | "assistant", content: string): Seed => ({ id, role, content })

const TZ = "America/Sao_Paulo"
const ev = (id: string, title: string, start: string, end: string, over: Record<string, unknown> = {}) => ({ id, title, start, end, allDay: false, ...over })
const PLAN_BASE = { date: "2026-11-10", timeZone: TZ, headline: "Hoje: 3 compromissos, 1 e-mail pede ação até sexta e 1 entrega chega.", runId: "run-9" }

const SEEDS: Seed[] = [
  text("c01", "user", "Marca um almoço com a Ana amanhã às 12h30, por uma hora. Convida ela."),
  card("c02", "calendar", { cardId: "calendar:run-1:created:e1", action: "created", timeZone: TZ, notified: true, events: [ev("e1", "Almoço com a Ana", "2026-11-11T15:30:00.000Z", "2026-11-11T16:30:00.000Z", { location: "Restaurante Sabor", attendeeCount: 1, conflict: true, link: "https://www.google.com/calendar/event?eid=1" })] }),
  text("c03", "assistant", "Marquei e mandei o convite para a Ana. Atenção: bate com a Reunião de produto, das 12h às 13h. Quer que eu mude o horário?"),
  text("c04", "user", "Passa a reunião de produto para as 16h."),
  card("c05", "calendar", { cardId: "calendar:run-2:updated:e2:call-1", action: "updated", timeZone: TZ, events: [ev("e2", "Reunião de produto", "2026-11-11T19:00:00.000Z", "2026-11-11T20:00:00.000Z", { location: "Sala 2", attendeeCount: 4, link: "https://www.google.com/calendar/event?eid=2" })] }),
  text("c06", "user", "O que tenho na quarta?"),
  card("c07", "calendar", { cardId: "calendar:run-3:listed", action: "listed", timeZone: TZ, events: [ev("e3", "Aula de cálculo", "2026-11-11T11:00:00.000Z", "2026-11-11T12:30:00.000Z", { location: "Bloco B" }), ev("e1", "Almoço com a Ana", "2026-11-11T15:30:00.000Z", "2026-11-11T16:30:00.000Z", { attendeeCount: 1 }), ev("e2", "Reunião de produto", "2026-11-11T19:00:00.000Z", "2026-11-11T20:00:00.000Z", { attendeeCount: 4 }), ev("e4", "Dia de provas", "2026-11-11", "2026-11-12", { allDay: true })] }),
  text("c08", "user", "E na quinta?"),
  card("c09", "calendar", { cardId: "calendar:run-4:listed", action: "listed", timeZone: TZ, events: [] }),
  card("c10", "day-plan", { ...PLAN_BASE, planId: "day-plan:run-9", sections: [
    { id: "commitments", items: [{ text: "Aula de cálculo", time: "08:00", detail: "Bloco B" }, { text: "Almoço com a Ana", time: "12:30" }, { text: "Reunião de produto", time: "16:00", detail: "Sala 2, 4 convidados" }] },
    { id: "emails", items: [{ text: "Contador pede o recibo de outubro", detail: "prazo sexta" }] },
    { id: "pending", items: [{ text: "Enviar o relatório de estudo" }, { text: "Ligar para o dentista" }] },
    { id: "deliveries", items: [{ text: "Fone Bluetooth X (Loja B)", detail: "pedido B-7731, rastreio BR123456789" }] },
  ], sourceErrors: [] }),
  card("c11", "day-plan", { ...PLAN_BASE, planId: "day-plan:run-10", headline: "Hoje: 1 e-mail pede ação até sexta. Não consegui ver tudo.", sections: [
    { id: "emails", items: [{ text: "Contador pede o recibo de outubro", detail: "prazo sexta" }] },
    { id: "deliveries", items: [{ text: "Fone Bluetooth X (Loja B)" }] },
  ], sourceErrors: [{ source: "calendar", reason: "failed" }, { source: "email", reason: "needs_connection" }] }),
  card("c12", "day-plan", { ...PLAN_BASE, planId: "day-plan:run-11", headline: "Dia livre: nada marcado e nenhum prazo.", sections: [], sourceErrors: [] }),
]

const GROUPS: Array<[string, string[]]> = [
  ["evento-criado-com-convite-e-conflito", ["c01", "c02", "c03"]],
  ["evento-alterado", ["c04", "c05"]],
  ["lista-do-dia", ["c06", "c07"]],
  ["dia-livre", ["c08", "c09"]],
  ["plano-do-dia-completo", ["c10"]],
  ["plano-do-dia-fonte-em-falha", ["c11"]],
  ["plano-do-dia-livre", ["c12"]],
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
  test.describe(`previews dos cartões de calendário e Plano do dia (escuro, ${size.name})`, () => {
    test.skip(!OUT, "defina CALENDAR_BRIEF_PREVIEW_DIR para gerar as capturas")
    test.use({ viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile, locale: "pt-BR" })
    test.beforeEach(async ({ context }) => {
      await context.addInitScript(() => localStorage.setItem("theme", "dark"))
    })

    test("cartões persistidos", async ({ context, page }) => {
      test.setTimeout(240_000)
      const api = new MockAtlas({ history: [] })
      const conversationId = "conv-e2e"
      const base = Date.parse("2026-11-10T10:30:00.000Z")
      SEEDS.forEach((seed, index) => {
        api.messages.push({ id: seed.id, conversationId, role: seed.role, content: seed.content, createdAt: new Date(base + index * 1000).toISOString() })
      })
      api.handler = libraryHandler
      await api.install(context)
      await openChat(page)
      await page.locator(`[data-message-id="c01"]`).waitFor()
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
      await page.waitForTimeout(2000)

      let n = 0
      for (const [name, ids] of GROUPS) {
        n += 1
        const rows = ids.map((id) => page.locator(`[data-message-id="${id}"]`).first())
        if ((await rows[0]!.count()) === 0) {
          console.log(`[calendario-brief] ${size.name}: grupo "${name}" sem linha, pulado`)
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
    })
  })
}
