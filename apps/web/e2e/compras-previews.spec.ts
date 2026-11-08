import { test, type Page } from "@playwright/test"
import { MockAtlas, type MockHandler } from "./mock-api"

/**
 * Capturas (tema escuro, desktop 1440 e celular 390) dos cartões de compras: produto (foto, preço e desconto, loja, frete,
 * total, avaliação, link), produto com campos faltando, comparação de lojas (menor total, frete não informado, foto que não
 * carrega) e compra registrada. Dados falsos; as fotos de loja são servidas pelo próprio teste (sem rede). No máximo 3 blocos
 * por imagem. Só roda com COMPRAS_PREVIEW_DIR (pasta de saída). COMPRAS_CHROMIUM_PATH aponta um Chromium já instalado.
 */
const OUT = process.env.COMPRAS_PREVIEW_DIR
const CHROMIUM = process.env.COMPRAS_CHROMIUM_PATH
if (CHROMIUM) test.use({ launchOptions: { executablePath: CHROMIUM } })

const SIZES = [
  { name: "desktop-1440", viewport: { width: 1440, height: 2400 }, mobile: false },
  { name: "mobile-390", viewport: { width: 390, height: 2400 }, mobile: true },
] as const

type Seed = { id: string; role: string; content: string }
const card = (id: string, role: string, body: Record<string, unknown>): Seed => ({ id, role, content: JSON.stringify({ v: 1, kind: role, ...body }) })
const text = (id: string, role: "user" | "assistant", content: string): Seed => ({ id, role, content })

const IMG = (n: number) => `https://cdn.lojas-exemplo.test/foto-${n}.svg`
const offer = (over: Record<string, unknown>) => ({ name: "Fone Bluetooth X", merchant: "Loja A", url: "https://loja-a.test/p/fone", price: 199.9, currency: "BRL", shipping: { kind: "paid", amount: 19.9 }, total: 219.8, availability: "in_stock", images: [], ...over })

const FULL = offer({ oldPrice: 249.9, images: [IMG(1), IMG(2), IMG(3)], description: "Fone sem fio com cancelamento de ruído, até 30 horas de bateria e estojo de carregamento.", rating: { value: 4.6, best: 5, count: 1287 } })
const BARE = offer({ name: "Cadeira de escritório ergonômica", merchant: "Móveis Nobre", url: "https://moveis-nobre.test/cadeira", price: 899, shipping: { kind: "unknown" }, total: null, availability: "limited", images: ["javascript:alert(1)"] })
const COMPARE = [
  offer({ merchant: "Loja A", url: "https://loja-a.test/p/fone", price: 100, shipping: { kind: "paid", amount: 40 }, total: 140, images: [IMG(1)], rating: { value: 4.5, best: 5, count: 80 } }),
  offer({ merchant: "Loja B", url: "https://loja-b.test/p/fone", price: 120, shipping: { kind: "free" }, total: 120, images: [IMG(2)], rating: { value: 4.2, best: 5, count: 12 } }),
  offer({ merchant: "Loja C", url: "https://loja-c.test/p/fone", price: 90, shipping: { kind: "unknown" }, total: null, images: [IMG(404)] }),
  offer({ merchant: "Loja D", url: "https://loja-d.test/p/fone", price: 95, oldPrice: 119, shipping: { kind: "free" }, total: 95, availability: "out_of_stock", images: [IMG(3)] }),
  offer({ merchant: "Loja E", url: "https://loja-e.test/p/fone", price: 80, priceFrom: true, shipping: { kind: "unavailable" }, total: null, images: [IMG(2)] }),
]

const SEEDS: Seed[] = [
  text("p01", "user", "Acha o fone Bluetooth X pra mim e me mostra o preço."),
  text("p02", "assistant", "Achei na Loja A. Está com 20% de desconto e o frete é R$ 19,90."),
  card("p03", "product", { cardId: "run-1:product:one", items: [FULL] }),
  card("p04", "product", { cardId: "run-1:product:bare", items: [BARE] }),
  text("p05", "user", "Compara em 3 lojas, com frete."),
  card("p06", "product", { cardId: "run-2:product:cmp", items: COMPARE, cheapestUrl: "https://loja-b.test/p/fone", incomplete: true }),
  text("p07", "assistant", "A Loja B tem o menor total conhecido (R$ 120,00). A Loja C não informa o frete, então ainda não dá para comparar."),
  text("p08", "user", "Comprei na Loja B, pedido B-7731."),
  card("p09", "purchase", { purchaseId: "pur-1", merchant: "Loja B", items: [{ name: "Fone Bluetooth X", quantity: 1, unitPrice: 120 }], total: 120, currency: "BRL", purchasedAt: "2026-11-07T15:00:00.000Z", orderNumber: "B-7731", trackingCode: "BR123456789", trackingUrl: "https://rastreio.lojas-exemplo.test/BR123456789" }),
  card("p10", "purchase", { purchaseId: "pur-2", merchant: "Papelaria Central", items: [{ name: "Caderno 200 folhas", quantity: 3, unitPrice: 24.5 }, { name: "Caneta gel azul", quantity: 10 }, { name: "Marca-texto", quantity: 4 }, { name: "Pasta sanfonada", quantity: 1 }, { name: "Grampeador", quantity: 1 }, { name: "Clipes 100un", quantity: 2 }], total: 147.3, currency: "BRL", purchasedAt: "2026-11-05T11:20:00.000Z" }),
]

const GROUPS: Array<[string, string[]]> = [
  ["produto-completo", ["p01", "p02", "p03"]],
  ["produto-sem-foto-sem-frete", ["p04"]],
  ["comparacao-de-lojas", ["p05", "p06", "p07"]],
  ["compra-registrada", ["p08", "p09"]],
  ["compra-varios-itens", ["p10"]],
]

const libraryHandler: MockHandler = ({ method, path }) =>
  method === "GET" && /^\/v1\/bots\/[^/]+\/pages$/.test(path)
    ? { body: { items: [] } }
    : method === "GET" && path === "/v1/usage"
      ? { body: { totals: { costUsd: 0, runs: 0, inputTokens: 0, outputTokens: 0 }, bots: [], models: [], days: [] } }
      : undefined

/** Foto de loja falsa: gradiente com uma forma, para a prévia mostrar a moldura real da imagem. */
const svg = (n: number) => {
  const hues = [215, 160, 28]
  const h = hues[(n - 1) % 3] ?? 215
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},70%,62%)"/><stop offset="1" stop-color="hsl(${h + 40},60%,38%)"/></linearGradient></defs><rect width="640" height="480" fill="url(#g)"/><circle cx="320" cy="240" r="120" fill="rgba(255,255,255,.22)"/><rect x="250" y="170" width="140" height="140" rx="28" fill="rgba(255,255,255,.55)"/></svg>`
}

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
  test.describe(`previews dos cartões de compras (escuro, ${size.name})`, () => {
    test.skip(!OUT, "defina COMPRAS_PREVIEW_DIR para gerar as capturas")
    test.use({ viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile, locale: "pt-BR" })
    test.beforeEach(async ({ context }) => {
      await context.addInitScript(() => localStorage.setItem("theme", "dark"))
    })

    test("cartões persistidos", async ({ context, page }) => {
      test.setTimeout(240_000)
      // As fotos "da loja" vêm do teste; a 404 prova que uma foto quebrada não quebra o layout.
      await context.route("https://cdn.lojas-exemplo.test/**", async (route) => {
        const n = Number(/foto-(\d+)\.svg/.exec(route.request().url())?.[1] ?? 0)
        if (n === 404) return route.fulfill({ status: 404, body: "" })
        return route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg(n) })
      })
      const api = new MockAtlas({ history: [] })
      const conversationId = "conv-e2e"
      const base = Date.parse("2026-11-07T12:00:00.000Z")
      SEEDS.forEach((seed, index) => {
        api.messages.push({ id: seed.id, conversationId, role: seed.role, content: seed.content, createdAt: new Date(base + index * 1000).toISOString() })
      })
      api.handler = libraryHandler
      await api.install(context)
      await openChat(page)
      await page.locator(`[data-message-id="p01"]`).waitFor()
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
      await page.waitForTimeout(2000)

      let n = 0
      for (const [name, ids] of GROUPS) {
        n += 1
        const rows = ids.map((id) => page.locator(`[data-message-id="${id}"]`).first())
        if ((await rows[0]!.count()) === 0) {
          console.log(`[compras] ${size.name}: grupo "${name}" sem linha, pulado`)
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
