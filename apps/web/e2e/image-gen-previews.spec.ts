import { readFileSync } from "node:fs"
import { test, type Page } from "@playwright/test"
import { MockAtlas } from "./mock-api"

/**
 * Capturas (390 e 1440, claro e escuro) do skeleton de `generate_image` (1 imagem 1:1, 2 imagens 16:9), do erro e da imagem final.
 * Só roda com IMAGE_PREVIEW_DIR definido (pasta de saída); IMAGE_PNG aponta a imagem final servida pelo mock.
 */
const OUT = process.env.IMAGE_PREVIEW_DIR
const PNG = process.env.IMAGE_PNG

async function openChat(page: Page) {
  await page.goto("/")
  const bot = page.getByRole("button", { name: /Bot principal Atlas/ })
  try {
    await bot.waitFor({ timeout: 12_000 })
  } catch {
    await page.reload()
  }
  await bot.click()
  await page.getByRole("textbox", { name: /Mensagem para/ }).waitFor()
}

async function ask(page: Page) {
  await page.getByRole("textbox", { name: /Mensagem para/ }).fill("gera uma imagem de um gato astronauta")
  await page.getByRole("button", { name: "Enviar mensagem" }).click()
}

for (const theme of ["light", "dark"] as const) {
  for (const [label, size] of [["mobile", { width: 390, height: 844 }], ["desktop", { width: 1440, height: 900 }]] as const) {
    test.describe(`image-gen ${theme} ${label}`, () => {
      test.skip(!OUT, "defina IMAGE_PREVIEW_DIR")
      test.beforeEach(async ({ context, page }) => {
        await page.setViewportSize(size)
        await context.addInitScript((value) => localStorage.setItem("theme", value), theme)
      })
      const shot = async (page: Page, name: string) => {
        await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
        await page.screenshot({ path: `${OUT}/${name}-${label}-${theme}.png` })
      }

      test("skeleton 1 imagem 1:1", async ({ context, page }) => {
        const api = new MockAtlas({ reply: "Pronto.", replyDelayMs: 600_000, imageGenInRun: { hold: true } })
        await api.install(context)
        await context.route(/\/v1\/files\//, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG ? readFileSync(PNG) : Buffer.alloc(0) }))
        await openChat(page)
        await ask(page)
        await page.getByTestId("image-pending").waitFor()
        await page.waitForTimeout(2200)
        await shot(page, "01-skeleton-1x1")
      })

      test("skeleton 2 imagens 16:9", async ({ context, page }) => {
        const api = new MockAtlas({ reply: "Pronto.", replyDelayMs: 600_000, imageGenInRun: { hold: true, count: 2, aspectRatio: "16:9" } })
        await api.install(context)
        await context.route(/\/v1\/files\//, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG ? readFileSync(PNG) : Buffer.alloc(0) }))
        await openChat(page)
        await ask(page)
        await page.getByTestId("image-pending").waitFor()
        await page.waitForTimeout(2200)
        await shot(page, "02-skeleton-2x-16x9")
      })

      test("erro", async ({ context, page }) => {
        const api = new MockAtlas({ reply: "Não consegui gerar a imagem agora.", imageGenInRun: { aspectRatio: "4:3", error: "Geração de imagem falhou (HTTP 402). No credits" } })
        await api.install(context)
        await context.route(/\/v1\/files\//, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG ? readFileSync(PNG) : Buffer.alloc(0) }))
        await openChat(page)
        await ask(page)
        await page.getByTestId("image-pending").waitFor()
        await page.waitForTimeout(300)
        await shot(page, "03-erro")
      })

      test("imagem final", async ({ context, page }) => {
        const api = new MockAtlas({ reply: "Aqui está o gato astronauta.", imageGenInRun: { imageIds: ["img-1"] } })
        await api.install(context)
        await context.route(/\/v1\/files\//, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG ? readFileSync(PNG) : Buffer.alloc(0) }))
        await openChat(page)
        await ask(page)
        await page.getByRole("button", { name: /Abrir imagem/ }).waitFor()
        await page.waitForTimeout(800)
        await shot(page, "04-imagem-final")
      })
    })
  }
}
