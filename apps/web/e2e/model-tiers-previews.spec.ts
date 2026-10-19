import { test, type Page } from "@playwright/test"
import { resolveEffectiveConfig } from "@workspace/shared"
import { MockAtlas } from "./mock-api"

/**
 * Capturas (390, claro e escuro) de "Modelos por dificuldade": a seção das Configurações com os níveis
 * preenchidos, o seletor do composer (Automático + modelos dos níveis) e a subvista do bot.
 * Só roda com TIERS_PREVIEW_DIR (pasta de saída); TIERS_PREVIEW_CHROMIUM aponta um Chromium já instalado.
 */
const OUT = process.env.TIERS_PREVIEW_DIR
const CHROMIUM = process.env.TIERS_PREVIEW_CHROMIUM

const MODELS = [
  { id: "openai/gpt-4o-mini", name: "OpenAI: GPT-4o mini", provider: "openai", contextLength: 128000, inputModalities: ["text", "image"], outputModalities: ["text"], supportedParameters: ["tools"] },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek: DeepSeek V4 Flash", provider: "deepseek", contextLength: 128000, inputModalities: ["text"], outputModalities: ["text"], supportedParameters: ["tools"] },
  { id: "google/gemini-2.5-flash", name: "Google: Gemini 2.5 Flash", provider: "google", contextLength: 1000000, inputModalities: ["text", "image"], outputModalities: ["text"], supportedParameters: ["tools"] },
  { id: "anthropic/claude-sonnet-5.5", name: "Anthropic: Claude Sonnet 5.5", provider: "anthropic", contextLength: 200000, inputModalities: ["text", "image"], outputModalities: ["text"], supportedParameters: ["tools"] },
  { id: "openai/gpt-5", name: "OpenAI: GPT-5", provider: "openai", contextLength: 400000, inputModalities: ["text", "image"], outputModalities: ["text"], supportedParameters: ["tools"] },
]

const TIERS = {
  easy: ["openai/gpt-4o-mini", "deepseek/deepseek-v4-flash"],
  medium: ["google/gemini-2.5-flash"],
  hard: ["anthropic/claude-sonnet-5.5", "openai/gpt-5", "google/gemini-2.5-flash"],
}

function install(api: MockAtlas, botTiers?: Record<string, string[]>) {
  const config = { v: 1, models: { tiers: TIERS, classifyWithReviewer: false } }
  api.handler = ({ method, path }) => {
    if (method === "GET" && path === "/v1/models") return { body: { models: MODELS, defaultModel: "openai/gpt-4o-mini" } }
    if (method === "GET" && path.startsWith("/v1/transcriptions/models")) return { body: { provider: "openai", defaultModel: "whisper-1", models: [{ id: "whisper-1", name: "Whisper", vendor: "openai", pricePerMinuteUsd: 0.006 }] } }
    if (method === "GET" && path === "/v1/settings") {
      return {
        body: {
          settings: { sandboxAutoStart: true },
          config,
          effective: resolveEffectiveConfig({ user: { config }, env: {} }),
          capabilities: { openrouterKey: true, isOwner: true },
        },
      }
    }
    if (method === "GET" && path === "/v1/bots") {
      return {
        body: {
          bots: [
            {
              id: "bot-e2e", name: "Assistente", snippet: "Bot de teste", color: "#6d5efc", shape: "rond", description: null, openRouterModel: null,
              language: "pt-BR", pinned: true, pinOrder: 0, notify: true, sectionId: null, memberIds: [], conversationId: "conv-e2e",
              lastMessage: null, unreadResults: 0, unreadCount: 0, firstUnreadMessageId: null, manualUnread: false, isPrimary: true,
              createdAt: "2026-10-15T12:00:00.000Z", updatedAt: "2026-10-15T12:00:00.000Z",
              policyJson: botTiers ? { modelTiers: botTiers } : null,
            },
          ],
        },
      }
    }
    return undefined
  }
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

if (CHROMIUM) test.use({ launchOptions: { executablePath: CHROMIUM } })

for (const theme of ["light", "dark"] as const) {
  test.describe(`previews de modelos por dificuldade (${theme})`, () => {
    test.skip(!OUT, "defina TIERS_PREVIEW_DIR para gerar as capturas")
    test.beforeEach(async ({ context }) => {
      await context.addInitScript((value) => localStorage.setItem("theme", value), theme)
    })
    const shot = async (page: Page, name: string, fullPage = false) => {
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" })
      await page.waitForTimeout(500)
      await page.screenshot({ path: `${OUT}/${name}-${theme}.png`, fullPage })
    }

    test("configurações: seção Modelos com os níveis preenchidos", async ({ context, page }) => {
      test.setTimeout(240_000)
      const api = new MockAtlas({ botName: "Assistente" })
      install(api)
      await api.install(context)
      await page.setViewportSize({ width: 390, height: 2000 })
      await page.goto("/?settings=modelos")
      for (let attempt = 0; attempt < 3 && (await page.getByText("This page couldn’t load").count()) > 0; attempt++) {
        await page.reload()
        await page.waitForTimeout(1500)
      }
      await page.getByText("Modelos por dificuldade").first().waitFor({ timeout: 60_000 })
      await page.waitForTimeout(1500)
      await shot(page, "a-configuracoes-modelos", true)
    })

    test("composer: seletor aberto com Automático e a lista", async ({ context, page }) => {
      test.setTimeout(240_000)
      const api = new MockAtlas({ botName: "Assistente" })
      install(api)
      await api.install(context)
      await openApp(page)
      await shot(page, "b0-composer-fechado")
      await page.getByRole("button", { name: "Modelo de linguagem" }).click()
      await page.getByText("Dos seus níveis").first().waitFor({ timeout: 30_000 })
      await shot(page, "b-composer-seletor-aberto")
    })

    test("bot: linha e subvista dos níveis", async ({ context, page }) => {
      test.setTimeout(240_000)
      const api = new MockAtlas({ botName: "Assistente" })
      install(api, { hard: ["anthropic/claude-sonnet-5.5", "openai/gpt-5"] })
      await api.install(context)
      await openApp(page)
      await page.getByRole("button", { name: "Configurações do bot" }).click()
      await page.getByRole("button", { name: "Abrir Modelos por dificuldade" }).waitFor({ timeout: 30_000 })
      await shot(page, "c1-bot-configuracoes")
      await page.getByRole("button", { name: "Abrir Modelos por dificuldade" }).click()
      await page.locator('[data-agent-settings-page="tiers"]').waitFor()
      await shot(page, "c2-bot-niveis")
    })
  })
}
