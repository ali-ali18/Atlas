import { readFileSync } from "node:fs"
import { expect, it, vi } from "vitest"
import {
  createChatgptStreamChat,
  createProviderFallbackStream,
  type CompleteChatWithToolsParams,
} from "@workspace/llm"
import type { ComputerUseEvent } from "@workspace/shared"
import type { SandboxManager } from "@workspace/sandbox"
import { runComputerUse, type RuntimeStepRecord } from "./computer-use.js"
import { buildMcpToolset } from "./mcp/registry.js"

vi.mock("@workspace/db", async (original) => ({
  ...(await original<typeof import("@workspace/db")>()),
  searchMemoryEntries: vi.fn(async () => []),
  getBotProfile: vi.fn(async () => null),
  listBotSkills: vi.fn(async () => []),
  searchSkillVersions: vi.fn(async () => []),
  listRoutines: vi.fn(async () => []),
  persistConversationCardFromEvent: vi.fn(async () => undefined),
}))
const fixture = (name: string) =>
  readFileSync(
    new URL(
      `../../llm/src/responses/__fixtures__/${name}.sse`,
      import.meta.url
    ),
    "utf8"
  )
const autonomy = { level: "autonomous" as const, exceptions: [] }
function dependencies() {
  const toolset = buildMcpToolset(
    [
      {
        id: "conn_fixture",
        slug: "data",
        name: "Data",
        disabledTools: [],
        tools: [
          {
            name: "lookup",
            inputSchema: {
              type: "object",
              properties: { id: { type: "number" } },
            },
            annotations: { readOnlyHint: true },
          },
        ],
      },
    ],
    { autonomy }
  )
  const connector = vi.fn(async () => ({
    ok: true,
    text: "fixture result",
    truncated: false,
  }))
  return {
    manager: {} as SandboxManager,
    getSessionId: async () => "unused",
    sandboxEnabled: false,
    model: "chatgpt/luna",
    apiKey: "unused",
    runId: "run_fixture",
    userId: "owner_fixture",
    origin: "chat",
    autonomy,
    language: "en-US" as const,
    maxSteps: 4,
    messages: [
      {
        role: "user" as const,
        content: "Read both values from the attached image.",
      },
    ],
    userImageArtifactIds: ["image_fixture"],
    canSeeUserImages: true,
    loadUserImage: async (id: string) =>
      id === "image_fixture" ? "data:image/png;base64,c3ludGhldGlj" : null,
    mcp: { toolset, call: connector },
    connector,
  }
}

it("replay com imagem, duas tools e reasoning agrega chamadas do plano sem custo USD desconhecido", async () => {
  const bodies: Array<Record<string, unknown>> = [],
    steps: RuntimeStepRecord[] = []
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(
        fixture(bodies.length === 1 ? "tools" : "text").replaceAll(
          '"lookup"',
          '"mcp__data__lookup"'
        )
      )
    })
  const deps = dependencies()
  const result = await runComputerUse({
    ...deps,
    onEvent: () => undefined,
    onStep: async (step) => {
      steps.push(step)
    },
    streamChat: createChatgptStreamChat({
      getAccessToken: async () => "fixture-access",
      fetch: fetcher,
    }),
  })
  expect(result.text).toBe("Hello")
  expect(deps.connector).toHaveBeenCalledTimes(2)
  const input = bodies[0]!.input as Array<{ content?: Array<{ type: string }> }>
  expect(
    input.some((item) =>
      item.content?.some((part) => part.type === "input_image")
    )
  ).toBe(true)
  const replay = bodies[1]!.input as Array<Record<string, unknown>>
  expect(replay.filter((item) => item.type === "reasoning")).toHaveLength(1)
  expect(
    replay
      .filter((item) => item.type === "function_call_output")
      .map((item) => item.call_id)
  ).toEqual(["call_fixture_a", "call_fixture_b"])
  expect(result.usage.planCalls).toBe(2)
  expect(result.usage.costUnknownCalls ?? 0).toBe(0)
  expect(result.usage.costUsd).toBeUndefined()
  const telemetry = steps
    .filter((step) => step.type === "model")
    .map((step) => step.telemetry!)
  expect(telemetry).toHaveLength(2)
  expect(
    telemetry.every(
      (step) => step.provider === "chatgpt" && step.costKind === "plan"
    )
  ).toBe(true)
})

it("quota entre decisões troca para OpenRouter sem ecoar itens privados e emite aviso visível", async () => {
  const notices: ComputerUseEvent[] = [],
    steps: RuntimeStepRecord[] = [],
    openrouterBodies: CompleteChatWithToolsParams[] = []
  let calls = 0,
    limitedAt: number | null = null
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () =>
        new Response(
          fixture(++calls === 1 ? "tools" : "failed").replaceAll(
            '"lookup"',
            '"mcp__data__lookup"'
          )
        )
    )
  const stream = createProviderFallbackStream({
    chatgpt: createChatgptStreamChat({
      getAccessToken: async () => "fixture-access",
      fetch: fetcher,
    }),
    openrouter: async (params, handlers) => {
      openrouterBodies.push(params)
      handlers?.onDelta?.("Fallback done.")
      return {
        model: params.model,
        message: { role: "assistant", content: "Fallback done." },
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          costUsd: 0.1,
        },
      }
    },
    fallbackModel: "deepseek/deepseek-v4.1-flash",
    getLastLimitAt: async () => limitedAt,
    markLimitAt: async (at) => {
      limitedAt = at
    },
    now: () => 1000,
    onFallback: (notice) => {
      notices.push(notice)
    },
  })
  const deps = dependencies()
  const result = await runComputerUse({
    ...deps,
    onEvent: (event) => {
      notices.push(event)
    },
    onStep: async (step) => {
      steps.push(step)
    },
    streamChat: stream,
  })
  expect(result.text).toBe("Fallback done.")
  expect(deps.connector).toHaveBeenCalledTimes(2)
  expect(limitedAt).toBe(1000)
  expect(openrouterBodies).toHaveLength(1)
  expect(
    openrouterBodies[0]!.messages.every((message) => !message.providerItems)
  ).toBe(true)
  expect(
    notices.filter((event) => event.type === "provider_fallback")
  ).toHaveLength(1)
  expect(JSON.stringify(notices)).not.toContain("fixture-access")
  expect(JSON.stringify(steps)).not.toContain("fixture-access")
  expect(result.usage.planCalls).toBe(1)
  expect(result.usage.costUnknownCalls ?? 0).toBe(0)
  expect(result.usage.costUsd).toBe(0.1)
  const models = steps.filter((step) => step.type === "model")
  expect(models[1]!.telemetry).toMatchObject({
    provider: "openrouter",
    fallbackFrom: "chatgpt/luna",
  })
})

it("cancelamento do pai interrompe stream do plano sem fallback pago nem tools", async () => {
  const controller = new AbortController()
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const openrouter = vi.fn()
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    entered()
    return new Response(
      new ReadableStream<Uint8Array>({
        start() {
          /* stream sem eventos até cancelamento */
        },
      })
    )
  })
  const deps = dependencies()
  const stream = createProviderFallbackStream({
    chatgpt: createChatgptStreamChat({
      getAccessToken: async () => "fixture-access",
      fetch: fetcher,
    }),
    openrouter,
    fallbackModel: "deepseek/deepseek-v4.1-flash",
    getLastLimitAt: async () => null,
    markLimitAt: async () => undefined,
  })
  const work = runComputerUse({
    ...deps,
    onEvent: () => undefined,
    abortSignal: controller.signal,
    streamChat: stream,
  })
  const failure = expect(work).rejects.toBeDefined()
  await started
  controller.abort()
  await failure
  expect(openrouter).not.toHaveBeenCalled()
  expect(deps.connector).not.toHaveBeenCalled()
}, 2000)
