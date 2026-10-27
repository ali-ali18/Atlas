import { test, type Page } from "@playwright/test"
import { MockAtlas, type MockHandler } from "./mock-api"

/**
 * Capturas (390 e 1440, claro e escuro) do brief "Seu dia": configuração "Horário de trabalho",
 * cartão da rotina criada e o brief como mensagem normal do bot no chat (sem painel). Só roda com SEU_DIA_PREVIEW_DIR (pasta de saída).
 */
const OUT = process.env.SEU_DIA_PREVIEW_DIR
/** Opcional: Chromium já instalado (quando a versão do Playwright não bate com o browser baixado). */
const CHROMIUM = process.env.SEU_DIA_CHROMIUM_PATH

if (CHROMIUM) test.use({ launchOptions: { executablePath: CHROMIUM } })

const SIZES = [
  { name: "390", viewport: { width: 390, height: 1400 }, mobile: true },
  { name: "1440", viewport: { width: 1440, height: 1200 }, mobile: false },
] as const

/** O brief é a mensagem: curto, sem cabeçalho nem enfeite, mistura aula, prazo e um e-mail. */
const BRIEF_FIRST_LINE = "Hoje você tem uma aula e um prazo, e um e-mail espera sua resposta."
const BRIEF_TEXT = [
  BRIEF_FIRST_LINE,
  "",
  "- 10h: aula de Estatística, sala 204. Leve a lista 3 para tirar dúvidas.",
  "- 14h30: consulta com a Dra. Paula (clínica da Rua Augusta).",
  "- Prazo hoje às 23h59: entrega do trabalho de História no portal.",
  "- Precisa de você: Marina, da turma, pergunta se pode dividir o grupo de Estatística.",
  "",
  "Próximos passos: terminar o trabalho de História antes da aula, depois responder a Marina.",
  "Reconecte o Gmail para eu ver os e-mails novos.",
].join("\n")

/** O mock base não conhece a lista de painéis da Biblioteca (devolve `{}` e a tela quebra): lista vazia. */
const libraryHandler: MockHandler = ({ method, path }) =>
  method === "GET" && /^\/v1\/bots\/[^/]+\/pages$/.test(path)
    ? { body: { items: [] } }
    : method === "GET" && path === "/v1/usage"
      ? { body: { totals: { costUsd: 0, runs: 0, inputTokens: 0, outputTokens: 0 }, bots: [], models: [], days: [] } }
      : undefined

/** No celular a tela inicial é a lista de conversas: abre a do bot. */
async function openChat(page: Page) {
  const bot = page.getByText("Atlas", { exact: true }).first()
  if (await page.getByRole("textbox").count() === 0 && (await bot.count()) > 0) await bot.click()
}

for (const size of SIZES) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`previews do Seu dia (${theme}, ${size.name}px)`, () => {
      test.skip(!OUT, "defina SEU_DIA_PREVIEW_DIR para gerar as capturas")
      test.use({
        viewport: size.viewport,
        isMobile: size.mobile,
        hasTouch: size.mobile,
      })
      test.beforeEach(async ({ context }) => {
        await context.addInitScript((value) => localStorage.setItem("theme", value), theme)
      })
      const prep = async (page: Page) => {
        await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
        await page.waitForTimeout(700)
      }
      const file = (name: string) => `${OUT}/${size.name}-${theme}-${name}.png`

      test("configurações: horário de trabalho", async ({ context, page }) => {
        test.setTimeout(150_000)
        const api = new MockAtlas()
        api.handler = libraryHandler
        await api.install(context)
        await page.goto("/")
        await page.getByRole("textbox").first().or(page.getByRole("button", { name: /Bot principal/ })).first().waitFor()
        await page.goto("/?settings=geral")
        for (let attempt = 0; attempt < 3 && (await page.getByText("This page couldn’t load").count()) > 0; attempt++) {
          await page.reload()
          await page.waitForTimeout(1500)
        }
        const start = page.getByLabel("Início do expediente")
        const geral = page.getByRole("button", { name: /^Geral/ }).first()
        if (size.mobile && !(await start.isVisible()) && (await geral.count()) > 0) await geral.click()
        await start.waitFor()
        await prep(page)
        const group = page.locator("section, div").filter({ has: page.getByLabel("Início do expediente") }).filter({ hasText: "Dias úteis" }).last()
        await group.scrollIntoViewIfNeeded()
        await group.screenshot({ path: file("horario") })
        // Erro: fim antes do início (não é enviado ao servidor).
        await page.getByLabel("Fim do expediente").fill("07:00")
        await page.getByRole("alert").filter({ hasText: "O início precisa ser antes do fim." }).waitFor()
        await prep(page)
        await group.screenshot({ path: file("horario-erro") })
      })

      test("cartão da rotina e brief como mensagem no chat", async ({ context, page }) => {
        test.setTimeout(150_000)
        const api = new MockAtlas({ history: [{ role: "user", content: "Quero um resumo do meu dia toda manhã, de segunda a sexta, às 7h30." }] })
        api.messages.push(
          {
            id: "m-seu-dia-1",
            conversationId: api.messages[0]!.conversationId,
            role: "assistant",
            content: "Pronto! Toda manhã, de segunda a sexta, às 07:30, eu te mando um resumo curto do seu dia aqui no chat.",
            createdAt: "2026-10-26T10:00:01.000Z",
          },
          {
            id: "m-seu-dia-2",
            conversationId: api.messages[0]!.conversationId,
            role: "routine",
            content: JSON.stringify({ v: 1, kind: "routine", action: "created", title: "Seu dia", routineId: "routine-seu-dia", triggerType: "cron", detail: "Seu dia · seg–sex às 07:30" }),
            createdAt: "2026-10-26T10:00:02.000Z",
          },
          {
            id: "m-seu-dia-3",
            conversationId: api.messages[0]!.conversationId,
            role: "assistant",
            content: BRIEF_TEXT,
            createdAt: "2026-10-27T10:30:00.000Z",
          },
        )
        api.handler = libraryHandler
        await api.install(context)
        await page.goto("/")
        if (size.mobile) {
          await page.getByText("Atlas", { exact: true }).first().waitFor()
          await openChat(page)
        }
        const routineCard = page.getByText("Seu dia · seg–sex às 07:30").first()
        await routineCard.waitFor()
        const brief = page.getByText(BRIEF_FIRST_LINE).first()
        await brief.waitFor()
        await prep(page)
        // Cartão da rotina (+ a fala do bot acima).
        const box = await routineCard.locator("xpath=ancestor::*[self::section or self::div][3]").boundingBox()
        if (!box) throw new Error("sem caixa")
        const x = Math.max(0, box.x - 8)
        const width = Math.min(size.viewport.width - x, box.width + 16)
        await page.screenshot({ path: file("cartao-rotina"), clip: { x, y: Math.max(0, box.y - 8), width, height: box.height + 16 } })
        // O brief: mensagem normal do bot, sem painel.
        await brief.scrollIntoViewIfNeeded()
        const briefBubble = brief.locator("xpath=ancestor::*[self::article or self::div][2]")
        await briefBubble.screenshot({ path: file("brief-mensagem") })
      })
    })
  }
}
