import { expect, test, type Browser, type Locator, type Page } from "@playwright/test"
import { MockAtlas, type MockHandler } from "./mock-api"

/**
 * Capturas (tema escuro, desktop 1440 e celular 390, escala 2) das compras da F6: cartões salvos em Configurações › Cofre e o
 * cartão de aprovação de compra com o campo de CVV. Dados falsos (número de teste público, CVV fictício); no máximo 3 blocos
 * por imagem. Só roda com COMPRAS_PREVIEW_DIR (pasta de saída) e o servidor com ATLAS_PREVIEW_PAGES=1 (a página de prévia
 * do cartão de compra só existe com ele). COMPRAS_CHROMIUM_PATH aponta um Chromium já instalado (opcional).
 */
const OUT = process.env.COMPRAS_PREVIEW_DIR
const CHROMIUM = process.env.COMPRAS_CHROMIUM_PATH
if (CHROMIUM) test.use({ launchOptions: { executablePath: CHROMIUM } })

const SIZES = [
  { name: "desktop-1440", viewport: { width: 1440, height: 900 }, mobile: false },
  { name: "mobile-390", viewport: { width: 390, height: 844 }, mobile: true },
] as const

type Card = { id: string; label: string; brand: string; last4: string; createdAt: string }
const makeCards = (): Card[] => [
  { id: "card-1", label: "Visa final 1111", brand: "visa", last4: "1111", createdAt: "2026-11-01T10:00:00.000Z" },
  { id: "card-2", label: "Cartão do trabalho", brand: "mastercard", last4: "4444", createdAt: "2026-11-03T10:00:00.000Z" },
]

type Seen = { created: unknown[]; responses: Array<{ path: string; body: unknown }> }

function makeHandler(state: { cards: Card[]; seen: Seen; respondStatus: number }): MockHandler {
  return ({ method, path, body }) => {
    // Painel lateral (Biblioteca) carregado atrás das configurações: respostas vazias, como nas outras prévias.
    if (method === "GET" && /^\/v1\/bots\/[^/]+\/pages$/.test(path)) return { body: { items: [] } }
    if (method === "GET" && /^\/v1\/bots\/[^/]+\/artifacts/.test(path)) return { body: { files: [], nextCursor: null } }
    if (method === "GET" && path.startsWith("/v1/usage")) return { body: { totals: { costUsd: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, runs: 0 }, byBot: [], byModel: [], daily: [] } }
    if (method === "GET" && /^\/v1\/agenda/.test(path)) return { body: { enabled: false, timezone: "America/Sao_Paulo", items: [], ended: [] } }
    if (method === "GET" && path === "/v1/vault") return { body: { items: [], available: true } }
    if (method === "GET" && path === "/v1/cards") return { body: { configured: true, cards: state.cards } }
    if (method === "POST" && path === "/v1/cards") {
      state.seen.created.push(body)
      const card = { id: `card-${state.cards.length + 1}`, label: "Elo final 5067", brand: "elo", last4: "5067", createdAt: new Date().toISOString() }
      state.cards.push(card)
      return { status: 201, body: { card } }
    }
    const del = /^\/v1\/cards\/([^/]+)$/.exec(path)?.[1]
    if (del && method === "DELETE") {
      state.cards = state.cards.filter((card) => card.id !== del)
      return { body: { ok: true } }
    }
    if (method === "POST" && /^\/v1\/agent-v4\/runs\/[^/]+\/requests\/[^/]+\/respond$/.test(path)) {
      state.seen.responses.push({ path, body })
      return state.respondStatus === 200 ? { body: { ok: true, status: "recorded", resumed: true } } : { status: state.respondStatus, body: { error: "payment_unavailable" } }
    }
    return undefined
  }
}

async function shot(page: Page, target: Locator, path: string) {
  await target.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await target.screenshot({ path })
}

for (const size of SIZES) {
  test.describe(`previews das compras (escuro, ${size.name})`, () => {
    test.skip(!OUT, "defina COMPRAS_PREVIEW_DIR para gerar as capturas")

    async function start(browser: Browser, url: string, respondStatus = 200) {
      const context = await browser.newContext({ locale: "pt-BR", viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile, deviceScaleFactor: 2, baseURL: test.info().project.use.baseURL })
      await context.addInitScript(() => localStorage.setItem("theme", "dark"))
      const page = await context.newPage()
      const state = { cards: makeCards(), seen: { created: [], responses: [] } as Seen, respondStatus }
      const api = new MockAtlas({ history: [] })
      api.handler = makeHandler(state)
      await api.install(context)
      // O `next dev` às vezes derruba a página na 1ª carga: abre a raiz uma vez e recarrega (até 3 vezes) se cair.
      await page.goto("/")
      await page.waitForTimeout(1500)
      await page.goto(url)
      for (let attempt = 0; attempt < 3 && (await page.getByText("This page couldn’t load").count()) > 0; attempt++) {
        await page.reload()
        await page.waitForTimeout(2000)
      }
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
      return { context, page, state }
    }

    test("cartões salvos: lista, formulário com erro e apagar com confirmação", async ({ browser }) => {
      test.setTimeout(300_000)
      const { context, page, state } = await start(browser, "/?settings=cofre")
      const list = page.locator('[data-slot="cards-list"]')
      await list.waitFor({ timeout: 60_000 })
      await expect(list.getByText("Mastercard final 4444")).toBeVisible()
      await shot(page, list, `${OUT}/${size.name}-1-cartoes-lista.png`)

      await list.getByRole("button", { name: "Adicionar cartão" }).click()
      const dialog = page.getByRole("dialog")
      await dialog.getByLabel("Número do cartão").fill("4111111111111112")
      await dialog.getByLabel("Nome impresso no cartão").fill("Marina Souza")
      await dialog.getByLabel("Validade (MM/AA)").fill("1026")
      await dialog.getByRole("button", { name: "Salvar cartão" }).click()
      await dialog.getByText("Confira o número do cartão.").waitFor()
      // Nenhum campo de CVV no formulário (de propósito).
      expect(await dialog.locator('input[autocomplete="cc-csc"], input[name*="cvv" i]').count()).toBe(0)
      await page.waitForTimeout(400)
      await dialog.screenshot({ path: `${OUT}/${size.name}-2-cartao-formulario-erro.png` })

      // Corrige e salva: o corpo enviado nunca leva CVV.
      await dialog.getByLabel("Número do cartão").fill("5067 0000 0000 0009")
      await dialog.getByLabel("Validade (MM/AA)").fill("1230")
      await dialog.getByPlaceholder("Rua e número").fill("Rua das Flores, 120")
      await dialog.getByPlaceholder("Cidade").fill("Recife")
      await dialog.getByPlaceholder("Estado").fill("PE")
      await dialog.getByPlaceholder("CEP").fill("50000-000")
      await dialog.getByRole("button", { name: "Salvar cartão" }).click()
      await page.getByRole("dialog").waitFor({ state: "detached" }).catch(() => undefined)
      expect(JSON.stringify(state.seen.created)).not.toMatch(/cvv|cvc|csc/i)

      const row = list.locator('[data-deletable-row="card-2"]')
      if (size.mobile) {
        await row.evaluate((el) => el.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true, clientX: 10, clientY: 10 })))
        await page.waitForTimeout(600)
        await row.evaluate((el) => {
          el.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch", bubbles: true }))
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
        })
      } else {
        await row.hover()
      }
      await list.getByRole("button", { name: /Apagar cartão Mastercard final 4444/ }).click()
      await list.getByText("Apagar este cartão?").waitFor()
      await shot(page, list, `${OUT}/${size.name}-3-cartao-apagar.png`)
      await context.close()
    })

    test("cartão de compra: pendente, com mandato e aprovado", async ({ browser }) => {
      test.setTimeout(300_000)
      const { context, page } = await start(browser, "/dev/compras")
      const root = page.locator("[data-purchase-preview]")
      await root.waitFor({ timeout: 90_000 })
      await shot(page, root, `${OUT}/${size.name}-4-compra-tres-estados.png`)
      await context.close()
    })

    test("cartão de compra: CVV digitado fica mascarado, vai só no corpo e o campo é limpo; falha mostra erro", async ({ browser }) => {
      test.setTimeout(300_000)
      const { context, page, state } = await start(browser, "/dev/compras")
      const card = page.locator('[data-preview-block="pending"]')
      await card.waitFor({ timeout: 90_000 })
      const field = card.locator('[data-slot="cvv-input"]')
      // Letras são ignoradas; só 3 a 4 dígitos.
      await field.pressSequentially("7a3b7")
      expect(await field.inputValue()).toBe("737")
      expect(await field.getAttribute("type")).toBe("password")
      expect(await field.getAttribute("autocomplete")).toBe("cc-csc")
      await shot(page, card, `${OUT}/${size.name}-5-compra-cvv-digitado.png`)
      await card.getByRole("button", { name: /Pagar/ }).click()
      await card.getByText("Código enviado").waitFor()
      expect(state.seen.responses).toHaveLength(1)
      expect(state.seen.responses[0]!.path).not.toContain("737")
      expect(state.seen.responses[0]!.body).toEqual({ decision: "approve", cvv: "737" })
      await context.close()

      // Servidor sem canal do CVV (503): erro claro, nada cobrado e o campo foi apagado mesmo assim.
      const second = await start(browser, "/dev/compras", 503)
      const failing = second.page.locator('[data-preview-block="pending"]')
      await failing.waitFor({ timeout: 90_000 })
      await failing.locator('[data-slot="cvv-input"]').fill("737")
      await failing.getByRole("button", { name: /Pagar/ }).click()
      await failing.getByText(/Nada foi cobrado/).waitFor()
      expect(await failing.locator('[data-slot="cvv-input"]').inputValue()).toBe("")
      await shot(second.page, failing, `${OUT}/${size.name}-6-compra-erro.png`)
      await second.context.close()
    })
  })
}
