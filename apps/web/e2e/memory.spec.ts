import { expect, test, type Page } from "@playwright/test"
import { MockAtlas, type MockOptions } from "./mock-api"

/**
 * Aba Memória nas configurações do bot, no celular (390x844): ver o que o bot lembra, editar inline, "Corrigir no chat" (rascunho sem enviar),
 * "O que mudou" com desfazer (e a recusa quando a memória mudou depois), chip "Memória atualizada · ver" no chat e
 * o "ver" da reflexão diária. A API é simulada no navegador (ver mock-api.ts).
 */

const SEED: MockOptions["memory"] = {
  entries: [
    { id: "e-user-1", target: "user", content: "Mora em Recife e prefere respostas curtas", source: "agent-tool", updatedAt: "2026-10-14T12:00:00.000Z" },
    { id: "e-bot-1", target: "memory", content: "O cliente Silva paga sempre no dia 10", source: "memory-review", updatedAt: "2026-10-15T09:00:00.000Z" },
    { id: "e-bot-2", target: "memory", content: "Relatório semanal vai para o grupo da diretoria", source: "user", updatedAt: "2026-10-15T11:00:00.000Z" },
  ],
  changes: [
    { id: "c-1", target: "memory", action: "replace", entryId: "e-bot-1", before: "O cliente Silva paga no dia 5", after: "O cliente Silva paga sempre no dia 10", source: "reflection", createdAt: "2026-10-15T09:00:00.000Z" },
    { id: "c-2", target: "user", action: "add", entryId: "e-user-1", before: null, after: "Mora em Recife e prefere respostas curtas", source: "chat", createdAt: "2026-10-14T12:00:00.000Z" },
    { id: "c-3", target: "memory", action: "remove", entryId: "e-gone", before: "Reunião de terça cancelada", after: null, source: "reflection", createdAt: "2026-10-13T08:00:00.000Z" },
  ],
  staleChangeIds: ["c-3"],
}

/** O `next dev` às vezes derruba a 1ª carga ("Router action dispatched before initialization"): recarrega (até 3 vezes). */
async function openApp(page: Page) {
  await page.goto("/")
  const bot = page.getByRole("button", { name: /Bot principal Atlas/ })
  try {
    await bot.waitFor({ timeout: 12_000 })
  } catch {
    await page.reload()
  }
  await bot.click()
}

async function openMemoryTab(page: Page) {
  await openApp(page)
  await expect(page.getByRole("textbox").first()).toBeVisible()
  await page.getByRole("button", { name: "Configurações do bot" }).click()
  await page.getByRole("tab", { name: "Memória" }).click()
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

test("a aba Memória mostra as duas seções, a origem de cada item e cabe em 390px", async ({ context, page }) => {
  const api = new MockAtlas({ memory: SEED })
  await api.install(context)
  await openMemoryTab(page)
  await expect(page.getByText("Todos os seus bots veem isto")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Sobre você" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Deste bot" })).toBeVisible()
  await expect(page.getByText("Mora em Recife e prefere respostas curtas").first()).toBeVisible()
  await expect(page.getByText(/Revisão da conversa · /).first()).toBeVisible()
  await expect(page.getByText(/Você adicionou · /).first()).toBeVisible()
  await expect(page.getByText(/Da conversa · /).first()).toBeVisible()
  await expect(page.getByRole("heading", { name: "O que mudou" })).toBeVisible()
  await noHorizontalScroll(page)
})

test("estado vazio das seções e do histórico", async ({ context, page }) => {
  const api = new MockAtlas()
  await api.install(context)
  await openMemoryTab(page)
  await expect(page.getByText(/Nada guardado sobre você ainda/)).toBeVisible()
  await expect(page.getByText(/ainda não guardou nada por conta própria/)).toBeVisible()
  await expect(page.getByText(/Nada mudou na memória nos últimos 30 dias/)).toBeVisible()
})

test("edita um item inline e a mudança entra em 'O que mudou'", async ({ context, page }) => {
  const api = new MockAtlas({ memory: SEED })
  await api.install(context)
  await openMemoryTab(page)
  const item = page.locator('[data-memory-item="e-user-1"]')
  await item.getByRole("button", { name: "Ações da memória" }).click()
  await page.getByRole("menuitem", { name: "Editar" }).click()
  const box = page.getByRole("textbox", { name: "Editar memória" })
  await box.fill("Mora em Olinda")
  await page.getByRole("button", { name: "Salvar" }).click()
  await expect(page.getByText("Mora em Olinda").first()).toBeVisible()
  expect(api.requests.some((r) => r.method === "PATCH" && r.path === "/v1/memory/entries/e-user-1")).toBe(true)
  await expect(page.getByText("Alterou").first()).toBeVisible()
})

test("adiciona uma memória em 'Deste bot'", async ({ context, page }) => {
  const api = new MockAtlas({ memory: SEED })
  await api.install(context)
  await openMemoryTab(page)
  await page.locator('[data-memory-section="memory-bot"]').getByRole("button", { name: "Adicionar" }).click()
  await page.getByRole("textbox", { name: /Nova memória/ }).fill("Prefere reuniões às 10h")
  await page.getByRole("button", { name: "Adicionar", exact: true }).last().click()
  await expect(page.getByText("Prefere reuniões às 10h").first()).toBeVisible()
  expect(api.requests.find((r) => r.method === "POST" && r.path === "/v1/memory")?.body).toMatchObject({ target: "memory", botId: "bot-e2e" })
})

test("'Corrigir no chat' deixa o rascunho no campo (cursor no fim), fecha o painel e não envia", async ({ context, page }) => {
  const api = new MockAtlas({ memory: SEED })
  await api.install(context)
  await openMemoryTab(page)
  const item = page.locator('[data-memory-item="e-bot-1"]')
  await item.getByRole("button", { name: "Ações da memória" }).click()
  await page.getByRole("menuitem", { name: "Corrigir no chat" }).click()
  const draft = 'Sobre o que você lembra: "O cliente Silva paga sempre no dia 10" — '
  const input = page.getByRole("textbox").first()
  await expect(input).toHaveValue(draft)
  await expect(input).toBeFocused()
  await expect.poll(() => input.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)).toBe(draft.length)
  await expect(page.getByRole("tab", { name: "Memória" })).toBeHidden()
  expect(api.postedObjectives()).toEqual([])
})

test("desfazer: mudança disponível desfaz; a que mudou depois mostra a recusa inline", async ({ context, page }) => {
  const api = new MockAtlas({ memory: SEED })
  await api.install(context)
  await openMemoryTab(page)
  const stale = page.locator('[data-memory-change="c-3"]')
  await stale.getByRole("button", { name: "Desfazer" }).click()
  await expect(stale.getByRole("alert")).toContainText("foi alterada depois")
  const ok = page.locator('[data-memory-change="c-2"]')
  await ok.getByRole("button", { name: "Desfazer" }).click()
  await expect(page.locator('[data-memory-change="c-2"]')).toHaveAttribute("data-undo-state", "undone")
  await expect(page.locator('[data-memory-item="e-user-1"]')).toHaveCount(0)
  await noHorizontalScroll(page)
})

test("aviso 'Memória atualizada' aparece depois da gravação no chat, sem ação", async ({ context, page }) => {
  const api = new MockAtlas({ memory: SEED, memoryToolInRun: true, reply: "Anotado." })
  await api.install(context)
  await openApp(page)
  const input = page.getByRole("textbox").first()
  await input.fill("Prefiro respostas curtas")
  await input.press("Enter")
  await expect(page.getByText("Anotado.").first()).toBeVisible()
  const chip = page.getByTestId("memory-updated-marker")
  await expect(chip).toBeVisible()
  await expect(chip).toContainText("Memória atualizada")
  await expect(chip.getByRole("button")).toHaveCount(0)
})

test("marcador da reflexão diária é só o aviso, sem 'ver'", async ({ context, page }) => {
  const api = new MockAtlas({ memory: SEED, reflectionMessage: "Revisei a memória: atualizei o dia de pagamento do Silva." })
  await api.install(context)
  await openApp(page)
  await expect(page.locator('[data-testid="source-marker"][data-source-kind="reflection"]')).toBeVisible()
  await expect(page.getByRole("button", { name: "Ver o que mudou na memória" })).toHaveCount(0)
})
