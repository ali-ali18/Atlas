import { expect, test, type Page } from "@playwright/test"
import { MockAtlas, type MockOptions } from "./mock-api"

/**
 * Aviso "Memória atualizada" no chat e marcador da reflexão diária (a memória segue automática; as configurações
 * do bot não têm mais aba Memória). A API é simulada no navegador (ver mock-api.ts).
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
