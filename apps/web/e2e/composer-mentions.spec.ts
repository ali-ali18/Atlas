import { expect, test, type Page } from "@playwright/test"
import { MockAtlas } from "./mock-api"

/**
 * Composer do chat 1:1 no celular: `/` lista as skills (conta + fábrica), `@` lista os outros bots; ↑↓ Enter Tab Esc
 * e toque escolhem; o token entra no texto e vira chip no balão enviado. A API é simulada (ver mock-api.ts).
 * Com COMPOSER_PREVIEW_DIR definido, grava as capturas de tela (390px) nessa pasta.
 */
const OUT = process.env.COMPOSER_PREVIEW_DIR


const OPTIONS = {
  extraBots: [
    { id: "bot-bia", name: "Bia", description: "Financeiro e notas fiscais" },
    { id: "bot-caio", name: "Caio Souza", description: "Vendas e propostas" },
  ],
  skills: [
    { name: "resumir-reuniao", description: "Resume a ata de uma reunião em tópicos e decisões" },
    { name: "relatorio-semanal", description: "Monta o relatório semanal de vendas" },
  ],
  connectors: {
    catalog: [
      { id: "gmail", name: "Gmail", description: "Lê e envia e-mails", icon: "/connectors/gmail.svg", status: "connected" },
      { id: "notion", name: "Notion", description: "Páginas e bancos de dados", icon: "/connectors/notion.svg", status: null },
    ],
    custom: [{ id: "c-meu", name: "Meu Servidor", url: "https://mcp.exemplo.com/sse", status: "connected" }],
  },
  builtinSkills: [
    { slug: "pesquisar", name: "Pesquisar", description: "Pesquisa na web e cita as fontes" },
    { slug: "memoria", name: "Memória", description: "Guarda e atualiza o que o bot sabe sobre você" },
  ],
}

/** O `next dev` às vezes recarrega a página na 1ª carga: tenta abrir o chat até 3 vezes. */
async function openChat(page: Page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto("/")
    try {
      await page.getByRole("button", { name: /Bot principal Atlas/ }).click({ timeout: 15_000 })
      await page.getByRole("textbox").first().waitFor({ timeout: 8_000 })
      return
    } catch {
      /* tenta de novo */
    }
  }
  await expect(page.getByRole("textbox").first()).toBeVisible()
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

/** O popup tem a mesma largura do campo: bordas esquerda e direita alinhadas. */
async function expectAlignedWithComposer(page: Page) {
  const popup = (await page.locator('[data-slot="mention-popup"]').boundingBox())!
  const field = (await page.locator('[data-slot="input-group"]').first().boundingBox())!
  expect(Math.abs(popup.x - field.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(popup.x + popup.width - (field.x + field.width))).toBeLessThanOrEqual(1)
  expect(popup.y + popup.height).toBeLessThanOrEqual(field.y)
}

test.beforeEach(async ({ page }) => {
  // Esconde o indicador "Compiling" do `next dev`, que não faz parte da tela.
  await page.addInitScript(() => {
    const style = document.createElement("style")
    style.textContent = "nextjs-portal{display:none!important}"
    document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style))
  })
})

test("/ abre as skills, filtra, escolhe por teclado e por toque, e Esc fecha", async ({ context, page }) => {
  const api = new MockAtlas(OPTIONS)
  await api.install(context)
  await openChat(page)
  const input = page.getByRole("textbox").first()
  const popup = page.locator('[data-slot="mention-popup"]')

  await input.fill("/")
  await expect(popup).toBeVisible()
  await expect(popup.getByRole("option")).toHaveCount(4)
  await expect(popup).toContainText("/resumir-reuniao")
  await expect(popup).toContainText("Pesquisa na web e cita as fontes")
  await expectAlignedWithComposer(page)
  await noHorizontalScroll(page)
  if (OUT) await page.screenshot({ path: `${OUT}/01-barra-skills.png` })

  await input.fill("/pe")
  await expect(popup.getByRole("option")).toHaveCount(1)
  await input.press("Enter")
  await expect(input).toHaveValue("/pesquisar ")
  await expect(popup).toHaveCount(0)

  await input.fill("use a /rel")
  await input.press("ArrowDown")
  await input.press("Tab")
  await expect(input).toHaveValue("use a /relatorio-semanal ")

  await input.fill("/zzz")
  await expect(popup).toContainText("Nenhuma skill")
  await input.press("Escape")
  await expect(popup).toHaveCount(0)

  await input.fill("/memo")
  await popup.getByRole("option").first().dispatchEvent("mousedown")
  await expect(input).toHaveValue("/memoria ")
})

test("@ abre só os outros bots; e-mail, caminho e a/b não abrem nada", async ({ context, page }) => {
  const api = new MockAtlas(OPTIONS)
  await api.install(context)
  await openChat(page)
  const input = page.getByRole("textbox").first()
  const popup = page.locator('[data-slot="mention-popup"]')

  await input.fill("pergunta ao @b")
  await expect(popup).toBeVisible()
  await expect(popup.getByRole("option")).toHaveCount(1)
  await expect(popup).toContainText("Bia")
  await expectAlignedWithComposer(page)
  if (OUT) await page.screenshot({ path: `${OUT}/02-barra-bots.png` })

  // Sem consulta: os dois bots e só os apps conectados, em seções.
  await input.fill("pergunta ao @")
  await expect(popup.getByRole("option")).toHaveCount(4)
  await expect(popup.locator('[data-slot="mention-section"]')).toHaveText(["Bots", "Apps"])
  await expect(popup).toContainText("Bia")
  await expect(popup).toContainText("Gmail")
  await expect(popup).toContainText("Meu Servidor")
  await expect(popup).not.toContainText("Notion")
  await expect(popup).not.toContainText("Atlas")
  await expect(popup.locator('[data-slot="mention-app-status"]').first()).toHaveText("Conectado")
  await expectAlignedWithComposer(page)
  await noHorizontalScroll(page)
  if (OUT) await page.screenshot({ path: `${OUT}/04-barra-apps.png` })

  // App ainda não conectado só aparece quando a consulta casa, com "Entrar".
  await input.fill("quero o @not")
  await expect(popup.getByRole("option")).toHaveCount(1)
  await expect(popup).toContainText("Notion")
  await expect(popup.locator('[data-slot="mention-app-status"]')).toHaveText("Entrar")
  await input.press("Tab")
  await expect(input).toHaveValue("quero o @Notion ")

  await input.fill("pergunta ao @ca")
  await input.press("Enter")
  await expect(input).toHaveValue("pergunta ao @Caio Souza ")

  await input.fill("@zzz")
  await expect(popup).toContainText("Nenhum bot ou app")

  for (const text of ["manda para ana@exemplo.com", "abre a/b", "veja https://exemplo.com/x"]) {
    await input.fill(text)
    await expect(popup).toHaveCount(0)
  }
})

test("a mensagem enviada mostra /skill e @Bot como chips e chega ao servidor com o texto digitado", async ({ context, page }) => {
  const api = new MockAtlas({ ...OPTIONS, reply: "Certo, vou cuidar disso." })
  await api.install(context)
  await openChat(page)
  const input = page.getByRole("textbox").first()
  const text = "use /pesquisar, leia o @Gmail e pergunte à @Bia o saldo, veja /tmp"
  await input.fill(text)
  await input.press("Enter")
  await expect(page.locator('[data-slot="skill-chip"]')).toHaveCount(1)
  await expect(page.locator('[data-slot="mention-chip"]')).toHaveCount(1)
  await expect(page.locator('[data-slot="app-chip"]')).toHaveCount(1)
  await expect(page.locator('[data-slot="skill-chip"]').first()).toHaveText("/pesquisar")
  await expect(page.getByText("Certo, vou cuidar disso.").first()).toBeVisible()
  expect(api.postedObjectives()).toEqual([text])
  await noHorizontalScroll(page)
  if (OUT) await page.screenshot({ path: `${OUT}/03-mensagem-com-chips.png` })
})
