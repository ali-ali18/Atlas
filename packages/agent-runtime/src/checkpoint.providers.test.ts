import { describe, expect, it } from "vitest"
import type { LlmMessage } from "@workspace/llm"
import { toResponses } from "../../llm/src/responses/to-responses.js"
import {
  buildRuntimeCheckpoint,
  hydrateLlmMessages,
  parseRuntimeCheckpoint,
  resolveLlmMessagesForModel,
} from "./checkpoint.js"

const model = "chatgpt/test-model"
const call = {
  id: "call-1",
  type: "function" as const,
  function: { name: "read", arguments: "{}" },
}
const items = [
  {
    type: "reasoning",
    id: "reason-1",
    encrypted_content: "opaque-fixture",
    summary: [],
  },
  {
    type: "function_call",
    id: "function-1",
    call_id: call.id,
    name: "read",
    arguments: "{}",
  },
]

describe("histórico do provedor no checkpoint", () => {
  it("carrega checkpoint antigo sem acrescentar histórico", async () => {
    const checkpoint = parseRuntimeCheckpoint({
      messages: [],
      llmMessages: [{ role: "assistant", content: "Resposta antiga" }],
      compact: true,
      activeElapsedMs: 123,
    })
    expect(checkpoint?.compact).toBe(true)
    expect(checkpoint?.activeElapsedMs).toBe(123)
    expect(checkpoint?.llmMessages?.[0]).not.toHaveProperty("providerItems")
    expect(await hydrateLlmMessages(checkpoint?.llmMessages ?? [])).toEqual([
      {
        role: "assistant",
        content: "Resposta antiga",
        tool_calls: undefined,
        tool_call_id: undefined,
      },
    ])
  })

  it("retoma reasoning, chamada e resultado após persistência JSON", async () => {
    const conversation: LlmMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [call],
        providerItems: { provider: "chatgpt", model, items },
      },
      { role: "tool", tool_call_id: call.id, content: "resultado" },
    ]
    const checkpoint = buildRuntimeCheckpoint({
      messages: [],
      conversation,
      nextStepIndex: 2,
      model,
      compact: true,
      activeElapsedMs: 450,
    })
    const parsed = parseRuntimeCheckpoint(
      JSON.parse(JSON.stringify(checkpoint))
    )
    const resumed = await hydrateLlmMessages(parsed?.llmMessages ?? [])
    const transport = await resolveLlmMessagesForModel(resumed)
    expect(transport[0]?.providerItems).toEqual(conversation[0]?.providerItems)
    expect(toResponses(transport, model).input).toEqual([
      ...items,
      { type: "function_call_output", call_id: call.id, output: "resultado" },
    ])
    expect(parsed?.nextStepIndex).toBe(2)
    expect(parsed?.activeElapsedMs).toBe(450)
    for (const switchedModel of ["chatgpt/other-model", "openai/gpt-4o-mini"]) {
      const translated = toResponses(transport, switchedModel).input
      expect(translated.map((item) => item.type)).toEqual([
        "function_call",
        "function_call_output",
      ])
      expect(JSON.stringify(translated)).not.toContain("opaque-fixture")
    }
  })

  it("preserva histórico na hidratação de conteúdo em partes", async () => {
    const conversation: LlmMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Pronto" }],
        providerItems: {
          provider: "chatgpt",
          model,
          items: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Pronto" }],
            },
          ],
        },
      },
    ]
    const checkpoint = buildRuntimeCheckpoint({
      messages: [],
      conversation,
      nextStepIndex: 1,
      model,
    })
    const parsed = parseRuntimeCheckpoint(
      JSON.parse(JSON.stringify(checkpoint))
    )
    const hydrated = await hydrateLlmMessages(parsed?.llmMessages ?? [])
    expect(hydrated).toEqual(
      conversation.map((message) => ({
        ...message,
        tool_calls: undefined,
        tool_call_id: undefined,
      }))
    )
    expect(
      toResponses(await resolveLlmMessagesForModel(hydrated), model).input
    ).toEqual(conversation[0]?.providerItems?.items)
  })

  it.each([
    null,
    42,
    [],
    {},
    { provider: "other", model, items },
    { provider: "chatgpt", model: "", items },
    { provider: "chatgpt", model, items: [null] },
    { provider: "chatgpt", model, items: [4] },
    { provider: "chatgpt", model, items: [[]] },
    { provider: "chatgpt", model, items: [{ type: "unsupported" }] },
  ])(
    "descarta histórico inválido sem impedir retomada: %j",
    async (providerItems) => {
      const parsed = parseRuntimeCheckpoint({
        messages: [],
        llmMessages: [{ role: "assistant", content: "texto", providerItems }],
      })
      expect(parsed).not.toBeNull()
      expect(parsed?.llmMessages?.[0]).not.toHaveProperty("providerItems")
      const resumed = await hydrateLlmMessages(parsed?.llmMessages ?? [])
      expect(resumed[0]?.content).toBe("texto")
      expect(resumed[0]).not.toHaveProperty("providerItems")
    }
  )
})
