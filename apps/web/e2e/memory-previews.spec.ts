import { test, type Page } from "@playwright/test"
import { MockAtlas, type MockOptions } from "./mock-api"

/**
 * Capturas de tela (390x844, claro e escuro) da aba Memória nas configurações do bot e do chip no chat.
 * Só roda com MEMORY_PREVIEW_DIR definido (pasta de saída); fora disso é pulado.
 */
const OUT = process.env.MEMORY_PREVIEW_DIR

const SEED: MockOptions["memory"] = {
  entries: [
    { id: "e-user-1", target: "user", content: "Mora em Recife e prefere respostas curtas", source: "agent-tool", updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() },
    { id: "e-user-2", target: "user", content: "Trabalha com importação e fala inglês nas reuniões", source: "user", updatedAt: new Date(Date.now() - 3_600_000).toISOString() },
    { id: "e-bot-1", target: "memory", content: "O cliente Silva paga sempre no dia 10, por boleto", source: "memory-review", updatedAt: new Date(Date.now() - 20 * 3_600_000).toISOString() },
    { id: "e-bot-2", target: "memory", content: "Relatório semanal vai para o grupo da diretoria", source: "agent-tool", updatedAt: new Date(Date.now() - 5 * 86_400_000).toISOString() },
  ],
  changes: [
    { id: "c-1", target: "memory", action: "replace", entryId: "e-bot-1", before: "O cliente Silva paga no dia 5", after: "O cliente Silva paga sempre no dia 10, por boleto", source: "reflection", createdAt: new Date(Date.now() - 20 * 3_600_000).toISOString() },
    { id: "c-2", target: "user", action: "add", entryId: "e-user-2", before: null, after: "Trabalha com importação e fala inglês nas reuniões", source: "user", createdAt: new Date(Date.now() - 3_600_000).toISOString() },
    { id: "c-3", target: "memory", action: "remove", entryId: "e-gone", before: "Reunião de terça cancelada", after: null, source: "reflection", createdAt: new Date(Date.now() - 26 * 3_600_000).toISOString() },
    { id: "c-4", target: "user", action: "replace", entryId: "e-user-1", before: "Mora em Olinda", after: "Mora em Recife e prefere respostas curtas", source: "chat", createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString() },
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

async function openSettings(page: Page) {
  await openApp(page)
  await page.getByRole("textbox").first().waitFor()
  await page.getByRole("button", { name: "Configurações do bot" }).click()
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`previews ${theme}`, () => {
    test.skip(!OUT, "defina MEMORY_PREVIEW_DIR para gerar as capturas")
    test.beforeEach(async ({ context }) => {
      await context.addInitScript((value) => localStorage.setItem("theme", value), theme)
    })
    // Esconde o indicador "Compiling" do `next dev`, que não faz parte da tela.
    const shot = async (page: Page, name: string) => {
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
      await page.screenshot({ path: `${OUT}/${name}-${theme}.png` })
    }

    test(`${theme}: geral, memória com dados, menu, edição e o que mudou`, async ({ context, page }) => {
      const api = new MockAtlas({ memory: SEED })
      await api.install(context)
      await openSettings(page)
      await shot(page, "01-configuracoes-aba-geral")
      await page.getByRole("tab", { name: "Memória" }).click()
      await page.getByText("Mora em Recife e prefere respostas curtas").first().waitFor()
      await shot(page, "02-memoria-com-dados")
      await page.locator('[data-memory-item="e-bot-1"]').getByRole("button", { name: "Ações da memória" }).click()
      await shot(page, "03-memoria-menu-aberto")
      await page.getByRole("menuitem", { name: "Editar" }).click()
      await page.getByRole("textbox", { name: "Editar memória" }).fill("O cliente Silva paga sempre no dia 12, por boleto")
      await shot(page, "04-memoria-edicao-inline")
      await page.getByRole("button", { name: "Cancelar" }).click()
      await page.locator('[data-memory-change="c-3"]').getByRole("button", { name: "Desfazer" }).click()
      await page.locator('[data-memory-change="c-3"]').getByRole("alert").waitFor()
      await page.locator('[data-memory-change="c-2"]').getByRole("button", { name: "Desfazer" }).click()
      await page.locator('[data-memory-change="c-2"][data-undo-state="undone"]').waitFor()
      await page.getByRole("heading", { name: "O que mudou" }).scrollIntoViewIfNeeded()
      await page.evaluate(() => document.querySelector('[data-memory-section="changes"]')?.scrollIntoView({ block: "start" }))
      await shot(page, "05-memoria-o-que-mudou-desfazer")
    })

    test(`${theme}: estado vazio`, async ({ context, page }) => {
      const api = new MockAtlas()
      await api.install(context)
      await openSettings(page)
      await page.getByRole("tab", { name: "Memória" }).click()
      await page.getByText(/Nada guardado sobre você ainda/).waitFor()
      await shot(page, "06-memoria-vazio")
    })

    test(`${theme}: chip no chat e ver da reflexão`, async ({ context, page }) => {
      const api = new MockAtlas({ memory: SEED, memoryToolInRun: true, reply: "Anotado. Vou responder mais curto daqui para frente.", reflectionMessage: "Revisei a memória de ontem: atualizei o dia de pagamento do Silva." })
      await api.install(context)
      await openApp(page)
      const input = page.getByRole("textbox").first()
      await input.fill("Prefiro respostas curtas")
      await input.press("Enter")
      await page.getByTestId("memory-updated-marker").waitFor()
      await shot(page, "07-chat-chip-memoria-atualizada")
    })
  })
}
