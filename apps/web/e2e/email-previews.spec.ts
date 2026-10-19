import { test, type Page } from "@playwright/test"
import { frameInboundEmail } from "@workspace/shared"
import { MockAtlas } from "./mock-api"

/**
 * Capturas (claro/escuro; 1440x900 e 390x844) do e-mail do bot: aba E-mail ativada com mensagens,
 * cartão "Enviar este e-mail?" e a conversa iniciada por e-mail. Só roda com EMAIL_PREVIEW_DIR definido.
 */
const OUT = process.env.EMAIL_PREVIEW_DIR

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const MIN = 60_000
const HOUR = 3_600_000

const ADDRESS = "assistente-k3x9qa@openmail.sh"
const MAILBOX = {
  id: "mbx-e2e", botId: "bot-e2e", provider: "openmail", address: ADDRESS,
  allowedSenders: ["ana.lima@empresa.com", "@parceiro.com.br"], dailySendLimit: 20, sentToday: 3, enabled: true, createdAt: ago(3 * 24 * HOUR),
}
const MESSAGES = [
  { id: "em-1", direction: "in", threadId: "thr-1", from: "ana.lima@empresa.com", to: [ADDRESS], subject: "Cotação de fretes para novembro", snippet: "Oi, consegue me mandar a cotação?", status: "received", conversationId: "conv-e2e", createdAt: ago(12 * MIN) },
  { id: "em-2", direction: "out", threadId: "thr-1", from: ADDRESS, to: ["ana.lima@empresa.com"], subject: "Re: Cotação de fretes para novembro", snippet: "Segue a cotação.", status: "sent", conversationId: "conv-e2e", createdAt: ago(9 * MIN) },
  { id: "em-3", direction: "in", threadId: "thr-2", from: "promo@loja-barata.biz", to: [ADDRESS], subject: "Você ganhou um prêmio!!!", snippet: "Clique aqui para resgatar", status: "blocked", conversationId: null, createdAt: ago(2 * HOUR) },
  { id: "em-4", direction: "in", threadId: "thr-3", from: "carlos@parceiro.com.br", to: [ADDRESS], subject: "Pedido 4821 — confirmação de entrega", snippet: "Confirmado para quinta-feira.", status: "received", conversationId: "conv-e2e", createdAt: ago(26 * HOUR) },
  { id: "em-5", direction: "out", threadId: "thr-3", from: ADDRESS, to: ["carlos@parceiro.com.br"], subject: "Re: Pedido 4821 — confirmação de entrega", snippet: "Obrigado.", status: "failed", conversationId: "conv-e2e", createdAt: ago(26 * HOUR - 5 * MIN) },
]
const ACCOUNT_OK = { provider: "openmail", configured: true, source: "account", vaultReady: true }
const ACCOUNT_NONE = { provider: "openmail", configured: false, source: null, vaultReady: true }

const THREAD_BODY = "Oi! Tudo bem?\n\nPreciso da cotação de frete para 3 paletes de São Paulo (SP) para Recife (PE), saída na próxima segunda. O peso total é de 1.200 kg e a nota fiscal é de R$ 18.400,00.\n\nSe possível, me passe duas opções: a mais barata e a mais rápida.\n\nObrigada,\nAna"
const EMAIL_FRAMED = frameInboundEmail({ from: "ana.lima@empresa.com", subject: "Cotação de fretes para novembro", threadId: "thr-1", body: THREAD_BODY })
const REPLY_BODY = "Oi, Ana!\n\nSegue a cotação para 3 paletes SP → Recife:\n- Mais barata: R$ 2.140,00, 6 dias úteis\n- Mais rápida: R$ 3.020,00, 3 dias úteis\n\nQuer que eu feche a opção mais barata?\n\nAbraço"

const SIZES = [
  { name: "390", viewport: { width: 390, height: 844 }, mobile: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, mobile: false },
] as const

type Msg = { id: string; conversationId: string; role: string; content: string; createdAt: string; source?: { kind: string; label: string; at: string } }

function seedConversation(api: MockAtlas, withConfirm: boolean) {
  const base = Date.now() - 12 * MIN
  const push = (m: Omit<Msg, "conversationId">) => (api.messages as Msg[]).push({ conversationId: "conv-e2e", ...m })
  push({ id: "m-in", role: "user", content: EMAIL_FRAMED, createdAt: new Date(base).toISOString(), source: { kind: "email", label: "Cotação de fretes para novembro", at: new Date(base).toISOString() } })
  push({ id: "m-bot", role: "assistant", content: "A Ana Lima pediu uma cotação de frete: 3 paletes de São Paulo para Recife, 1.200 kg, saída na segunda. Consultei as tabelas e montei duas opções; preparei a resposta para ela.", createdAt: new Date(base + 40_000).toISOString() })
  if (withConfirm) {
    push({
      id: "m-confirm", role: "confirm", createdAt: new Date(base + 45_000).toISOString(),
      content: JSON.stringify({ v: 1, kind: "confirm", confirmId: "confirm-email-run1-ab12cd34", title: "Enviar este e-mail?", description: `Para: ana.lima@empresa.com\nAssunto: Re: Cotação de fretes para novembro\n\n${REPLY_BODY}`, status: "pending", confirmLabel: "Enviar", cancelLabel: "Cancelar" }),
    })
  }
}

function seedSetup(api: MockAtlas, kind: "key" | "create") {
  const base = Date.now() - 2 * MIN
  const push = (m: Omit<Msg, "conversationId">) => (api.messages as Msg[]).push({ conversationId: "conv-e2e", ...m })
  push({ id: "u-1", role: "user", content: kind === "key" ? "Quero que você tenha um e-mail só seu para atender os clientes." : "Já salvei a chave. Pode criar o e-mail.", createdAt: new Date(base).toISOString() })
  if (kind === "key") {
    push({ id: "a-1", role: "assistant", content: "Para criar o e-mail eu preciso da chave da sua conta no OpenMail. Cole no cartão abaixo: ela não passa por mim.", createdAt: new Date(base + 20_000).toISOString() })
    push({
      id: "c-1", role: "confirm", createdAt: new Date(base + 25_000).toISOString(),
      content: JSON.stringify({ v: 1, kind: "confirm", confirmId: "confirm-emailkey-run1", title: "Falta a chave do OpenMail", description: "Cole a chave da sua conta no OpenMail para o bot ter um e-mail. Ela vai direto do campo para o servidor, criptografada: o bot não a vê.", status: "pending", confirmLabel: "Salvar chave", cancelLabel: "Agora não", emailKeyRequest: { provider: "openmail" } }),
    })
  } else {
    push({ id: "a-1", role: "assistant", content: "Posso criar o endereço agora. Confirme no cartão abaixo: ele usa uma das suas caixas gratuitas.", createdAt: new Date(base + 20_000).toISOString() })
    push({
      id: "c-1", role: "confirm", createdAt: new Date(base + 25_000).toISOString(),
      content: JSON.stringify({ v: 1, kind: "confirm", confirmId: "confirm-emailbox-run1", title: "Criar o e-mail assistente-k3x9qa@openmail.sh para este bot?", description: "Cria uma caixa no OpenMail e gasta uma das caixas gratuitas da sua conta. Depois você escolhe quem pode escrever para o bot na aba E-mail.", status: "pending", confirmLabel: "Criar e-mail", cancelLabel: "Cancelar" }),
    })
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const size of SIZES) {
    test.describe(`previews de e-mail (${theme}, ${size.name}px)`, () => {
      test.skip(!OUT, "defina EMAIL_PREVIEW_DIR para gerar as capturas")
      test.use({ viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile })
      test.beforeEach(async ({ context }) => {
        await context.addInitScript((value) => localStorage.setItem("theme", value), theme)
      })
      const shot = async (page: Page, name: string, fullPage = false) => {
        await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
        await page.waitForTimeout(500)
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
        if (overflow) throw new Error(`rolagem horizontal em ${name}`)
        await page.screenshot({ fullPage, path: `${OUT}/${size.name}-${theme}-${name}.png` })
      }
      async function openApp(page: Page) {
        await page.goto("/")
        const bot = page.getByRole("button", { name: /Bot principal Assistente/ })
        try {
          await bot.waitFor({ timeout: 12_000 })
        } catch {
          await page.reload()
        }
        await bot.click()
        await page.getByRole("textbox").first().waitFor()
      }
      async function openEmailTab(page: Page) {
        const toggle = page.getByRole("button", { name: "Alternar painel" }).first()
        await toggle.waitFor()
        // No desktop o painel já abre sozinho; só alterna quando está fechado.
        if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
        await page.getByRole("tab", { name: "E-mail" }).waitFor()
        await page.waitForTimeout(600)
        await page.getByRole("tab", { name: "E-mail" }).click()
      }

      test("aba E-mail ativada, edição e remoção", async ({ context, page }) => {
        const state = { mailbox: { ...MAILBOX, allowedSenders: [...MAILBOX.allowedSenders] }, enabled: true }
        const api = new MockAtlas({ botName: "Assistente" })
        api.handler = ({ method, path, body }) => {
          if (path === "/v1/bots/bot-e2e/email") {
            if (method === "PATCH") {
              const patch = body as { allowedSenders?: string[]; dailySendLimit?: number; enabled?: boolean }
              Object.assign(state.mailbox, patch)
            }
            return { body: { account: ACCOUNT_OK, mailbox: state.mailbox, messages: MESSAGES } }
          }
          if (path === "/v1/email/account") return { body: ACCOUNT_OK }
          return undefined
        }
        await api.install(context)
        await openApp(page)
        await openEmailTab(page)
        await page.getByTestId("email-address").waitFor()
        await page.locator('[data-email-message="em-1"]').waitFor()
        await shot(page, "01-aba-email-ativada")
        await page.getByLabel("Adicionar remetente permitido").fill("carlos@parceiro")
        await page.locator('[data-email-section="email-allowed"]').getByRole("button", { name: "Adicionar" }).click()
        await page.getByRole("alert").first().waitFor()
        await shot(page, "02-aba-email-erro-remetente")
        await page.getByLabel("Adicionar remetente permitido").fill("financeiro@empresa.com")
        await page.locator('[data-email-section="email-allowed"]').getByRole("button", { name: "Adicionar" }).click()
        await page.locator('[data-allowed-sender="financeiro@empresa.com"]').waitFor()
        await page.getByRole("button", { name: "Remover endereço" }).scrollIntoViewIfNeeded()
        await page.getByRole("button", { name: "Remover endereço" }).click()
        await page.getByRole("alertdialog").waitFor()
        await shot(page, "03-aba-email-remover-confirmacao")
      })

      test("aba E-mail sem chave e sem endereço", async ({ context, page }) => {
        const api = new MockAtlas({ botName: "Assistente" })
        api.handler = ({ path }) => {
          if (path === "/v1/bots/bot-e2e/email") return { body: { account: ACCOUNT_NONE, mailbox: null, messages: [] } }
          if (path === "/v1/email/account") return { body: ACCOUNT_NONE }
          return undefined
        }
        await api.install(context)
        await openApp(page)
        await openEmailTab(page)
        await page.getByTestId("email-no-key").waitFor()
        await shot(page, "04-aba-email-sem-chave")
      })

      test("conversa iniciada por e-mail", async ({ context, page }) => {
        const api = new MockAtlas({ botName: "Assistente" })
        seedConversation(api, false)
        await api.install(context)
        await openApp(page)
        await page.getByTestId("email-received-card").waitFor()
        await shot(page, "05-conversa-iniciada-por-email")
      })

      test("cartão Enviar este e-mail?", async ({ context, page }) => {
        const api = new MockAtlas({ botName: "Assistente" })
        seedConversation(api, true)
        await api.install(context)
        await openApp(page)
        await page.getByText("Enviar este e-mail?").first().waitFor()
        await page.getByText("Enviar este e-mail?").first().scrollIntoViewIfNeeded()
        await shot(page, "06-cartao-enviar-email")
      })

      test("cartão de chave do OpenMail", async ({ context, page }) => {
        const api = new MockAtlas({ botName: "Assistente" })
        seedSetup(api, "key")
        await api.install(context)
        await openApp(page)
        await page.locator("[data-email-key-request]").waitFor()
        await page.getByLabel("Chave da API do OpenMail").fill("om_exemplo_chave_fake_123")
        await shot(page, "08-cartao-chave-openmail")
      })

      test("cartão Criar e-mail", async ({ context, page }) => {
        const api = new MockAtlas({ botName: "Assistente" })
        seedSetup(api, "create")
        await api.install(context)
        await openApp(page)
        await page.getByText(/^Criar o e-mail assistente/).first().waitFor()
        await shot(page, "09-cartao-criar-email")
      })
    })
  }
}
