import { test, type Page } from "@playwright/test"
import { MockAtlas } from "./mock-api"

/**
 * Capturas (390 e 1440, claro e escuro) da navegação das Configurações e de cada seção.
 * Só roda com SETTINGS_PREVIEW_DIR (pasta de saída); SETTINGS_PREVIEW_TAG vira o prefixo (antes/depois);
 * SETTINGS_PREVIEW_SECTIONS lista os ids de seção (separados por vírgula).
 */
const OUT = process.env.SETTINGS_PREVIEW_DIR
const TAG = process.env.SETTINGS_PREVIEW_TAG ?? "depois"
const SECTIONS = (process.env.SETTINGS_PREVIEW_SECTIONS ?? "geral,provedores,bots,computador,conexoes,avancado").split(",")

const SIZES = [
  { name: "390", viewport: { width: 390, height: 2200 }, mobile: true },
  { name: "1440", viewport: { width: 1440, height: 1500 }, mobile: false },
] as const

for (const size of SIZES) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`previews das configurações (${theme}, ${size.name}px)`, () => {
      test.skip(!OUT, "defina SETTINGS_PREVIEW_DIR para gerar as capturas")
      test.use({ viewport: size.viewport, isMobile: size.mobile, hasTouch: size.mobile })
      test.beforeEach(async ({ context }) => {
        await context.addInitScript((value) => localStorage.setItem("theme", value), theme)
      })
      const shot = async (page: Page, name: string) => {
        await page.addStyleTag({
          content:
            "nextjs-portal{display:none!important}[data-slot=dialog-content]:not([class*=h-dvh]){height:auto!important;max-height:none!important}",
        })
        await page.waitForTimeout(700)
        await page.screenshot({ path: `${OUT}/${TAG}-${size.name}-${theme}-${name}.png`, fullPage: size.mobile })
      }

      test(`navegação e seções`, async ({ context, page }) => {
        test.setTimeout(400_000)
        const api = new MockAtlas()
        api.handler = ({ method, path }) =>
          method === "GET" && path === "/v1/reflection"
            ? { body: { settings: { enabled: true, time: "03:00" }, memory: { limit: 2200, used: 640 }, timezone: "America/Sao_Paulo", hasPrimary: true, active: false, last: null } }
            : method === "GET" && path.startsWith("/v1/transcriptions/models")
            ? { body: { provider: "openai", defaultModel: "whisper-1", models: [{ id: "whisper-1", name: "Whisper" }] } }
            : method === "GET" && path.startsWith("/v1/usage")
            ? { body: { totals: { costUsd: 1.37, promptTokens: 1000, completionTokens: 500, totalTokens: 1500, runs: 12 }, byBot: [], byModel: [], daily: [] } }
            : undefined
        await api.install(context)
        await page.goto("/")
        await page.getByRole("textbox").first().or(page.getByRole("button", { name: /Bot principal/ })).first().waitFor()
        await page.goto("/?settings=geral")
        await page.getByText("Configurações", { exact: true }).or(page.getByRole("navigation", { name: "Seções das configurações" })).first().waitFor()
        await shot(page, "00-navegacao")
        for (const id of SECTIONS) {
          await page.goto(`/?settings=${id}`)
          // O `next dev` às vezes derruba a página na 1ª carga: recarrega (até 3 vezes).
          for (let attempt = 0; attempt < 3 && (await page.getByText("This page couldn’t load").count()) > 0; attempt++) {
            await page.reload()
            await page.waitForTimeout(1500)
          }
          await page.waitForTimeout(1500)
          await shot(page, id)
        }
      })
    })
  }
}
