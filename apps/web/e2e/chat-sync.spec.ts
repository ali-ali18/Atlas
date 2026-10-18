import { expect, test, type Page } from "@playwright/test"
import { MockAtlas } from "./mock-api"

/**
 * Sincronização do chat no celular: a conversa tem que mostrar cada mensagem uma vez, na ordem, mesmo com a
 * conexão do stream caindo no meio, o app indo para segundo plano com o stream congelado, ou duas mensagens
 * enviadas em sequência antes do run existir. A API é simulada no navegador (ver mock-api.ts).
 */

const FIRST = "Primeira metade da resposta do bot."
const SECOND = "Segunda metade da resposta do bot."

async function setVisibility(page: Page, state: "hidden" | "visible") {
  await page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => next })
    Object.defineProperty(document, "hidden", { configurable: true, get: () => next === "hidden" })
    document.dispatchEvent(new Event("visibilitychange"))
    window.dispatchEvent(new Event(next === "hidden" ? "pagehide" : "pageshow"))
  }, state)
}

async function openChat(page: Page) {
  await page.goto("/")
  await page.getByRole("button", { name: /Bot principal Atlas/ }).click()
  await expect(page.getByRole("textbox").first()).toBeVisible()
}

async function send(page: Page, text: string) {
  const input = page.getByRole("textbox").first()
  await input.fill(text)
  await input.press("Enter")
}

async function top(page: Page, text: string): Promise<number> {
  const box = await page.getByText(text, { exact: false }).first().boundingBox()
  expect(box, `"${text}" deveria estar na tela`).not.toBeNull()
  return box!.y
}

test("a conexão do stream cai no meio da resposta: reconecta pelo cursor e mostra a resposta inteira uma vez", async ({ context, page }) => {
  const api = new MockAtlas({ reply: `${FIRST}\n\n${SECOND}`, dropFirstStream: true })
  await api.install(context)
  await openChat(page)
  await send(page, "Conte uma história")
  await expect(page.getByText(SECOND).first()).toBeVisible()
  // reconectou (pelo menos duas conexões ao stream do mesmo run), deixa o resto do stream assentar e nada ficou repetido
  await expect.poll(() => api.requests.filter((r) => r.path === "/v1/runs/run-1/stream").length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
  await page.waitForTimeout(1500)
  await expect(page.getByText(FIRST)).toHaveCount(1)
  await expect(page.getByText(SECOND)).toHaveCount(1)
  await expect(page.getByText("Conte uma história")).toHaveCount(1)
  // o histórico persistido (uma linha por parágrafo) também não duplica depois de um recarregamento
  await page.reload()
  await page.getByRole("button", { name: /Bot principal Atlas/ }).click()
  await expect(page.getByText(SECOND).first()).toBeVisible()
  await expect(page.getByText(FIRST)).toHaveCount(1)
  await expect(page.getByText(SECOND)).toHaveCount(1)
  expect(api.postedObjectives()).toEqual(["Conte uma história"])
})

test("vai para segundo plano com o stream congelado e volta: a resposta gravada aparece uma vez", async ({ context, page }) => {
  const api = new MockAtlas({ reply: `${FIRST}\n\n${SECOND}`, replyDelayMs: 1500, freezeStream: true })
  await api.install(context)
  await openChat(page)
  await send(page, "Pesquise algo demorado")
  await setVisibility(page, "hidden")
  await expect.poll(() => api.messages.filter((m) => m.role === "assistant").length, { timeout: 10_000 }).toBe(2)
  await setVisibility(page, "visible")
  await expect(page.getByText(SECOND).first()).toBeVisible()
  await expect(page.getByText(FIRST)).toHaveCount(1)
  await expect(page.getByText(SECOND)).toHaveCount(1)
  await expect(page.getByText("Pesquise algo demorado")).toHaveCount(1)
  // o composer volta a funcionar (não ficou preso em "enviando")
  await expect(page.getByRole("textbox").first()).toBeEditable()
})

test("duas mensagens enviadas em sequência antes do run existir: as duas chegam, uma vez, na ordem", async ({ context, page }) => {
  const api = new MockAtlas({ reply: "Resposta final do bot para as duas mensagens.", createRunDelayMs: 700, replyDelayMs: 2500 })
  await api.install(context)
  await openChat(page)
  await send(page, "primeira mensagem do usuário")
  await send(page, "segunda mensagem do usuário")
  await expect(page.getByText("Resposta final do bot para as duas mensagens.").first()).toBeVisible({ timeout: 20_000 })
  // o servidor recebeu a primeira como run e a segunda como input do mesmo run
  expect(api.postedObjectives()).toEqual(["primeira mensagem do usuário"])
  expect(api.inputs.map((i) => i.content)).toEqual(["segunda mensagem do usuário"])
  await expect(page.getByText("primeira mensagem do usuário")).toHaveCount(1)
  await expect(page.getByText("segunda mensagem do usuário")).toHaveCount(1)
  const [a, b, reply] = [await top(page, "primeira mensagem do usuário"), await top(page, "segunda mensagem do usuário"), await top(page, "Resposta final do bot")]
  expect(a).toBeLessThan(b)
  expect(b).toBeLessThan(reply)
  // depois de recarregar, a conversa do servidor mostra o mesmo, sem repetir
  await page.reload()
  await page.getByRole("button", { name: /Bot principal Atlas/ }).click()
  await expect(page.getByText("Resposta final do bot").first()).toBeVisible()
  await expect(page.getByText("primeira mensagem do usuário")).toHaveCount(1)
  await expect(page.getByText("segunda mensagem do usuário")).toHaveCount(1)
})
