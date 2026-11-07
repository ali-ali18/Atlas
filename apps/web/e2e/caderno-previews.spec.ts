import { resolveEffectiveConfig } from "@workspace/shared"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { MockAtlas, type MockHandler } from "./mock-api"

/**
 * Capturas (tema escuro, desktop 1440 e celular 390, escala 2) da seção "Caderno" da Biblioteca: notas, o que o bot
 * aprendeu (regras) e a revisão da noite. Dados falsos variados; no máximo 3 blocos por imagem. Só roda com
 * CADERNO_PREVIEW_DIR (pasta de saída). CADERNO_CHROMIUM_PATH aponta um Chromium já instalado (opcional).
 */
const OUT = process.env.CADERNO_PREVIEW_DIR
const CHROMIUM = process.env.CADERNO_CHROMIUM_PATH
if (CHROMIUM) test.use({ launchOptions: { executablePath: CHROMIUM } })

const SIZES = [
  { name: "desktop-1440", viewport: { width: 1440, height: 900 }, mobile: false },
  { name: "mobile-390", viewport: { width: 390, height: 844 }, mobile: true },
] as const

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)

type Note = { id: string; botId: string | null; title: string; body: string; pinned: boolean; source: "owner" | "agent" | "sleep"; createdAt: string; updatedAt: string }
const makeNotes = (): Note[] => [
  { id: "n1", botId: null, title: "Alergias da família", body: "Mari: amendoim. Pedro: camarão. Sempre avisar antes de sugerir restaurante.", pinned: true, source: "owner", createdAt: ago(900), updatedAt: ago(300) },
  { id: "n2", botId: null, title: "Roteiro de Lisboa", body: "Chegada dia 12 às 14h, hotel perto do Chiado (reserva em nome da Marina). Dia 13: Belém e pastel de nata; jantar no Time Out Market. Dia 14: Sintra de trem, levar casaco. Dia 15: LX Factory e fado em Alfama. Voo de volta dia 17 às 9h40, sair do hotel às 6h.", pinned: false, source: "agent", createdAt: ago(60), updatedAt: ago(2) },
  { id: "n3", botId: "bot-e2e", title: "Café sem açúcar nas reuniões", body: "Prefere café sem açúcar e reuniões curtas de manhã.", pinned: false, source: "sleep", createdAt: ago(20), updatedAt: ago(14) },
  { id: "n4", botId: "bot-outro", title: "Lista do mercado", body: "Arroz, feijão, café, leite de aveia.", pinned: false, source: "owner", createdAt: ago(100), updatedAt: ago(50) },
]

const RULES = [
  { id: "rule_a", match: "*", effect: "send", verdict: "approve", note: "Sempre me mostre o texto antes de enviar", source: "learned", learnedAt: ago(96) },
  { id: "rule_b", match: "*", effect: "money", verdict: "deny", note: null, source: "owner", learnedAt: null },
  { id: "rule_c", match: "drive_list_files", effect: "read", verdict: "run", note: null, source: "learned", learnedAt: ago(500) },
]

const proposal = (id: string, over: Record<string, unknown>) => ({ id, status: "open", ...over })
const REPORTS = [
  {
    id: "rep-1", botId: "bot-e2e", kind: "daily", slot: day(1), status: "done",
    summary: "Guardei 2 fatos e 1 nota. Tenho para você olhar: 1 habilidade e 1 caso de teste das falhas. Dá para desfazer cada mudança.",
    proposals: [
      proposal("skill:a", { kind: "skill", name: "Conferir planilha de vendas", description: "Abrir a planilha, somar a coluna do mês e avisar se passar da meta.", instructions: "..." }),
      proposal("eval:b", { kind: "eval_case", runId: "run_9", failureClass: "model.loop", evidence: ["e"], input: "Resuma os e-mails da semana e monte a lista de pendências" }),
    ],
    stats: {}, createdAt: ago(10), finishedAt: ago(10),
  },
  { id: "rep-2", botId: "bot-e2e", kind: "daily", slot: day(2), status: "done", summary: "Nada novo para guardar hoje.", proposals: [], stats: {}, createdAt: ago(34), finishedAt: ago(34) },
  {
    id: "rep-3", botId: "bot-e2e", kind: "doctor", slot: day(6), status: "done",
    summary: "Achei 2 coisas repetidas ou velhas na memória. Nada foi apagado: está tudo para você decidir.",
    proposals: [
      proposal("doc:1", { kind: "doctor", finding: { type: "duplicate", subject: "memory", ids: ["m1", "m2"], reason: "“Mora em Recife” aparece duas vezes com palavras diferentes." } }),
      proposal("doc:2", { kind: "doctor", finding: { type: "conflict", subject: "note", ids: ["n3", "n9"], reason: "Duas notas dizem horários diferentes para a reunião de segunda." } }),
      { ...proposal("doc:3", { kind: "doctor", finding: { type: "stale", subject: "memory", ids: ["m7"], reason: "“Está procurando apartamento” é de 8 meses atrás." } }), status: "dismissed" },
    ],
    stats: {}, createdAt: ago(140), finishedAt: ago(140),
  },
  { id: "rep-4", botId: "bot-e2e", kind: "daily", slot: day(3), status: "failed", summary: null, proposals: [], stats: {}, createdAt: ago(60), finishedAt: ago(60) },
]

const CHANGES: Record<string, unknown[]> = {
  "rep-1": [
    { id: "c1", botId: "bot-e2e", entryId: "e1", target: "memory", action: "add", before: null, after: "Prefere café sem açúcar", source: "sleep", undoOfId: null, createdAt: ago(10), undoneAt: null, reportId: "rep-1" },
    { id: "c-stale", botId: "bot-e2e", entryId: "e2", target: "memory", action: "replace", before: "Trabalha às terças", after: "Trabalha às terças e quintas", source: "sleep", undoOfId: null, createdAt: ago(10), undoneAt: null, reportId: "rep-1" },
    { id: "c3", botId: "bot-e2e", entryId: "n3", target: "note", action: "add", before: null, after: "Prefere café sem açúcar e reuniões curtas de manhã.", afterNote: { title: "Café sem açúcar nas reuniões", pinned: false }, source: "sleep", undoOfId: null, createdAt: ago(10), undoneAt: ago(1), reportId: "rep-1" },
  ],
  "rep-3": [],
}

type Mode = { createError?: "limit" | "duplicate" }

function makeHandler(state: { notes: Note[]; reports: typeof REPORTS; mode: Mode }): MockHandler {
  return ({ method, path, body, query }) => {
    if (method === "GET" && path === "/v1/settings") {
      return { body: { settings: { sandboxAutoStart: true }, config: { v: 1 }, effective: resolveEffectiveConfig({ user: { config: null }, env: {} }), capabilities: { openrouterKey: true, isOwner: true, engineV4: true } } }
    }
    if (method === "GET" && /^\/v1\/bots\/[^/]+\/pages$/.test(path)) return { body: { items: [] } }
    if (method === "GET" && /^\/v1\/bots\/[^/]+\/artifacts/.test(path)) return { body: { files: [], nextCursor: null } }
    if (method === "GET" && path.startsWith("/v1/usage")) return { body: { totals: { costUsd: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, runs: 0 }, byBot: [], byModel: [], daily: [] } }
    if (method === "GET" && path === "/v1/notes") {
      const botId = query.get("botId")
      return { body: { notes: botId ? state.notes.filter((note) => note.botId === null || note.botId === botId) : state.notes, limit: 500 } }
    }
    if (method === "POST" && path === "/v1/notes") {
      if (state.mode.createError === "limit") return { status: 409, body: { error: "cheio", code: "limit" } }
      if (state.mode.createError === "duplicate") return { status: 409, body: { error: "repetida", code: "duplicate" } }
      const input = body as { title: string; body: string; botId?: string | null }
      const note: Note = { id: `n-${state.notes.length + 1}`, botId: input.botId ?? null, title: input.title, body: input.body, pinned: false, source: "owner", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      state.notes.unshift(note)
      return { status: 201, body: { note } }
    }
    const noteId = /^\/v1\/notes\/([^/]+)$/.exec(path)?.[1]
    if (noteId && method === "PATCH") {
      const note = state.notes.find((item) => item.id === noteId)
      if (!note) return { status: 404, body: { error: "Nota não encontrada" } }
      Object.assign(note, body, { updatedAt: new Date().toISOString() })
      return { body: { note } }
    }
    if (noteId && method === "DELETE") {
      state.notes = state.notes.filter((item) => item.id !== noteId)
      return { body: { ok: true } }
    }
    if (method === "GET" && /^\/v1\/bots\/[^/]+\/rules$/.test(path)) return { body: { rules: RULES } }
    if (method === "GET" && path === "/v1/sleep/reports") return { body: { reports: state.reports, nextCursor: null } }
    if (method === "GET" && path === "/v1/sleep/changes") return { body: { changes: CHANGES[query.get("reportId") ?? ""] ?? [], nextCursor: null } }
    const undo = /^\/v1\/memory\/changes\/([^/]+)\/undo$/.exec(path)?.[1]
    if (undo && method === "POST") {
      if (undo === "c-stale") return { status: 409, body: { error: "stale", code: "stale", message: "stale" } }
      return { body: { change: { id: "undo-1", undoOfId: undo, createdAt: new Date().toISOString() } } }
    }
    const dismiss = /^\/v1\/sleep\/reports\/([^/]+)\/proposals\/([^/]+)\/dismiss$/.exec(path)
    if (dismiss && method === "POST") {
      const report = state.reports.find((item) => item.id === dismiss[1])
      const target = report?.proposals.find((item) => item.id === decodeURIComponent(dismiss[2]!))
      if (!report || !target) return { status: 404, body: { error: "Proposta não encontrada" } }
      target.status = "dismissed"
      return { body: { report } }
    }
    return undefined
  }
}

async function openLibrary(page: Page) {
  const toggle = page.locator('[aria-label="Abrir painel lateral"], [aria-label="Open side panel"]').first()
  if ((await toggle.count()) > 0) {
    await toggle.evaluate((el) => (el as HTMLElement).click())
    await page.waitForTimeout(800)
  }
  await page.getByRole("tab", { name: /^Biblioteca$/ }).click({ timeout: 15_000 }).catch(() => {})
  await page.getByText("Caderno", { exact: true }).first().waitFor({ state: "visible", timeout: 30_000 })
}

/** Abre o Caderno e, se pedido, os sub-blocos de regras e revisão. */
async function openNotebook(page: Page, blocks: Array<"rules" | "review"> = []) {
  const section = page.locator('[data-library-section="notebook"]')
  await section.getByText("Caderno", { exact: true }).first().click()
  await section.locator('[data-notebook-block="notes"]').waitFor()
  if (blocks.includes("rules")) await section.getByText("O que o bot aprendeu", { exact: true }).click()
  if (blocks.includes("review")) await section.getByText("Revisão da noite", { exact: true }).click()
  await page.waitForTimeout(700)
  return section
}

async function shot(page: Page, target: Locator, path: string) {
  await target.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await target.screenshot({ path })
}

for (const size of SIZES) {
  test.describe(`previews do Caderno (escuro, ${size.name})`, () => {
    test.skip(!OUT, "defina CADERNO_PREVIEW_DIR para gerar as capturas")

    async function start(browser: import("@playwright/test").Browser, mode: Mode = {}, enabled = true) {
      const context = await browser.newContext({ locale: "pt-BR", viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile, deviceScaleFactor: 2, baseURL: test.info().project.use.baseURL })
      await context.addInitScript(() => localStorage.setItem("theme", "dark"))
      const page = await context.newPage()
      const state = { notes: makeNotes(), reports: structuredClone(REPORTS), mode }
      const api = new MockAtlas({ history: [] })
      const handler = makeHandler(state)
      api.handler = enabled
        ? handler
        : (request) => (request.method === "GET" && request.path === "/v1/settings" ? undefined : handler(request))
      await api.install(context)
      await page.goto("/")
      const bot = page.getByRole("button", { name: /Atlas/ }).first()
      await bot.waitFor({ timeout: 60_000 })
      if (!(await page.locator("[data-message-id]").first().isVisible())) await bot.click()
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
      return { context, page, state }
    }

    test("notas: lista, filtro, fixadas e origem", async ({ browser }) => {
      test.setTimeout(240_000)
      const { context, page } = await start(browser)
      await openLibrary(page)
      const section = await openNotebook(page)
      await shot(page, section, `${OUT}/${size.name}-1-notas.png`)
      await section.getByRole("button", { name: "Todas" }).click()
      await expect(section.getByText("Lista do mercado")).toBeVisible()
      await page.waitForTimeout(400)
      await shot(page, section, `${OUT}/${size.name}-2-notas-todas.png`)
      await context.close()
    })

    test("notas: criar com erro, apagar com confirmação", async ({ browser }) => {
      test.setTimeout(240_000)
      const { context, page } = await start(browser, { createError: "limit" })
      await openLibrary(page)
      const section = await openNotebook(page)
      await section.getByRole("button", { name: "Nova nota" }).click()
      await section.getByLabel("Título").fill("Aniversário do Pedro")
      await section.getByLabel("Texto").fill("Dia 22 de dezembro. Ele quer um bolo de cenoura e nada de surpresa.")
      await section.getByRole("button", { name: "Salvar" }).click()
      await section.getByText(/O caderno está cheio/).waitFor()
      await shot(page, section.locator('[data-notebook-block="notes"]'), `${OUT}/${size.name}-3-notas-criar-erro.png`)
      await section.getByRole("button", { name: "Cancelar" }).click()
      // Apagar: no desktop a lixeira aparece no hover/foco; no celular, só depois de pressão longa.
      const row = section.locator('[data-deletable-row="n3"]')
      if (size.mobile) {
        await row.evaluate((el) => {
          el.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true, clientX: 10, clientY: 10 }))
        })
        await page.waitForTimeout(600)
        // Ao soltar o dedo o navegador gera um clique, que a pressão longa engole de propósito (não abre o item por engano).
        await row.evaluate((el) => {
          el.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch", bubbles: true }))
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
        })
      } else {
        await row.hover()
      }
      await section.getByRole("button", { name: /Apagar nota Café sem açúcar/ }).click()
      await section.getByText(/Apagar a nota/).waitFor()
      await shot(page, section.locator('[data-notebook-block="notes"]'), `${OUT}/${size.name}-4-notas-apagar.png`)
      await context.close()
    })

    test("o que o bot aprendeu: lista e edição", async ({ browser }) => {
      test.setTimeout(240_000)
      const { context, page } = await start(browser)
      await openLibrary(page)
      const section = await openNotebook(page, ["rules"])
      await section.getByText("Quando o bot for enviar mensagens").waitFor()
      await shot(page, section.locator('[data-notebook-block="rules"]'), `${OUT}/${size.name}-5-regras.png`)
      await section.getByRole("button", { name: "Editar regra: gastar dinheiro" }).click()
      await section.locator("[data-notebook-rule-form]").waitFor()
      await shot(page, section.locator('[data-notebook-block="rules"]'), `${OUT}/${size.name}-6-regras-editar.png`)
      await context.close()
    })

    test("revisão da noite: mudanças, desfazer e propostas", async ({ browser }) => {
      test.setTimeout(240_000)
      const { context, page } = await start(browser)
      await openLibrary(page)
      const section = await openNotebook(page, ["review"])
      await section.getByText("Guardou: Prefere café sem açúcar").waitFor()
      // Desfazer que o servidor recusa porque o item mudou depois (409 stale), em frase simples.
      await section.getByRole("button", { name: /Desfazer: Mudou: Trabalha às terças e quintas/ }).click()
      await section.getByText(/mudou depois/).waitFor()
      await shot(page, section.locator('[data-notebook-block="review"]'), `${OUT}/${size.name}-7-revisao-noite.png`)
      // Dispensar uma proposta ("Agora não") e abrir o relatório de domingo.
      await section.getByRole("button", { name: /Agora não: Conferir planilha/ }).click()
      await section.getByText("Dispensado").first().waitFor()
      await section.getByText("Revisão de domingo", { exact: false }).first().click()
      await section.getByText(/aparece duas vezes/).waitFor()
      await shot(page, section.locator('[data-notebook-block="review"]'), `${OUT}/${size.name}-8-revisao-domingo.png`)
      await context.close()
    })

    test("v4 desligado: a Biblioteca não mostra o Caderno", async ({ browser }) => {
      test.setTimeout(240_000)
      const { context, page } = await start(browser, {}, false)
      const toggle = page.locator('[aria-label="Abrir painel lateral"], [aria-label="Open side panel"]').first()
      if ((await toggle.count()) > 0) await toggle.evaluate((el) => (el as HTMLElement).click())
      await page.getByRole("tab", { name: /^Biblioteca$/ }).click({ timeout: 15_000 }).catch(() => {})
      await page.getByText("Rotinas", { exact: true }).first().waitFor({ state: "visible", timeout: 30_000 })
      await page.waitForTimeout(1000)
      expect(await page.getByText("Caderno", { exact: true }).count()).toBe(0)
      await shot(page, page.locator("[data-bot-library]"), `${OUT}/${size.name}-9-v4-desligado.png`)
      await context.close()
    })
  })
}
