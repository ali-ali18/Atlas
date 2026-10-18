import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CompleteChatWithToolsParams } from "../chat-tools.js"
import { createChatgptStreamChat } from "./stream.js"
import { ChatgptProviderError } from "./errors.js"
import { toResponses } from "./to-responses.js"
const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}.sse`, import.meta.url), "utf8")
const response = (name = "text") => new Response(fixture(name))
const params: CompleteChatWithToolsParams = {
  model: "chatgpt/luna",
  apiKey: "never-forward",
  tools: [],
  messages: [{ role: "user", content: "Hello" }],
}
afterEach(() => vi.useRealTimers())

describe("stream SIWC oficial sem rede", () => {
  it("mapeia texto, uso, timing e corpo sem usar apiKey do loop", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response())
    const token = vi.fn().mockResolvedValue("fixture-access")
    const onDelta = vi.fn()
    const result = await createChatgptStreamChat({
      getAccessToken: token,
      fetch: fetchFn,
    })(params, { onDelta })
    expect(result.message.content).toBe("Hello")
    expect(result.finishReason).toBe("stop")
    expect(result.usage).toMatchObject({
      totalTokens: 30,
      costKind: "plan",
      reasoningTokens: 9,
    })
    expect(result.usage).not.toHaveProperty("costUnknown")
    expect(result.appliedOutputCap).toBe(false)
    expect(result.timing).toMatchObject({
      attempts: 1,
      servedModel: "chatgpt/luna",
      requestedModel: params.model,
    })
    expect(onDelta).toHaveBeenCalledWith("Hello")
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "https://api.openai.com/v1/responses"
    )
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer fixture-access",
    })
    expect(fetchFn.mock.calls[0]?.[1]?.body).not.toContain(params.apiKey)
    expect(fetchFn.mock.calls[0]?.[1]?.redirect).toBe("error")
  })
  it("preserva duas chamadas paralelas e reasoning em ordem para o próximo turno", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response("tools"))
    const result = await createChatgptStreamChat({
      getAccessToken: async () => "fixture-access",
      fetch: fetchFn,
    })(params)
    expect(result.finishReason).toBe("stop")
    expect(result.message.tool_calls?.map((call) => call.id)).toEqual([
      "call_fixture_a",
      "call_fixture_b",
    ])
    expect(result.message.tool_calls?.[1]?.function.arguments).toBe("{}")
    const history = [
      result.message,
      ...result.message.tool_calls!.map((call) => ({
        role: "tool" as const,
        tool_call_id: call.id,
        content: "ok",
      })),
    ]
    expect(
      toResponses(history, params.model).input.map((item) => item.type)
    ).toEqual([
      "reasoning",
      "function_call",
      "function_call",
      "function_call_output",
      "function_call_output",
    ])
  })
  it.each([
    ["subscription_sharing_usage_limit_exceeded", 429],
    ["subscription_sharing_unsupported_capability", 400],
    ["subscription_sharing_not_eligible", 403],
    ["subscription_sharing_user_not_eligible", 403],
    ["subscription_sharing_invalid_user", 401],
    ["subscription_sharing_usage_unavailable", 503],
  ])("não retenta %s e descarta mensagem externa", async (code, status) => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code, message: "fixture-secret must never escape" },
          }),
          { status }
        )
      )
    const token = vi.fn().mockResolvedValue("fixture-access")
    await expect(
      createChatgptStreamChat({ getAccessToken: token, fetch: fetchFn })(params)
    ).rejects.toMatchObject({ code, status })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(token).toHaveBeenCalledTimes(1)
  })
  it("falha terminal in-stream mantém código para fallback", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response("failed"))
    await expect(
      createChatgptStreamChat({
        getAccessToken: async () => "fixture-access",
        fetch: fetchFn,
      })(params)
    ).rejects.toMatchObject({
      code: "subscription_sharing_usage_limit_exceeded",
      status: 429,
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
  it("401 faz um refresh com token anterior e só uma nova chamada", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(response())
    const token = vi
      .fn()
      .mockResolvedValueOnce("fixture-old")
      .mockResolvedValueOnce("fixture-new")
    await createChatgptStreamChat({ getAccessToken: token, fetch: fetchFn })(
      params
    )
    expect(token.mock.calls).toEqual([
      [],
      [{ force: true, previousAccessToken: "fixture-old" }],
    ])
    expect(fetchFn.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer fixture-new",
    })
    fetchFn
      .mockReset()
      .mockImplementation(async () => new Response("{}", { status: 401 }))
    await expect(
      createChatgptStreamChat({
        getAccessToken: async () => "fixture-token",
        fetch: fetchFn,
      })(params)
    ).rejects.toMatchObject({ code: "needs_login" })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
  it("retenta 502 antes do delta, sem repetir texto já entregue", async () => {
    vi.useFakeTimers()
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 502 }))
      .mockResolvedValueOnce(response())
    const work = createChatgptStreamChat({
      getAccessToken: async () => "fixture-access",
      fetch: fetchFn,
    })(params)
    await vi.runAllTimersAsync()
    expect((await work).timing?.attempts).toBe(2)
    const truncated = fixture("text").split("event: response.completed")[0]!
    fetchFn.mockReset().mockResolvedValue(new Response(truncated))
    expect(
      (
        await createChatgptStreamChat({
          getAccessToken: async () => "fixture-access",
          fetch: fetchFn,
        })(params)
      ).finishReason
    ).toBe("incomplete")
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
  it("nenhuma mensagem ou código arbitrário de erro expõe credencial", () => {
    expect(new ChatgptProviderError(502, "fixture-secret")).toMatchObject({
      code: "upstream_error",
    })
    expect(
      new ChatgptProviderError(502, "fixture-secret").message
    ).not.toContain("fixture-secret")
  })
})

it("erros fatais do cofre não são convertidos em retry de rede", async () => {
  const fetchFn = vi.fn<typeof fetch>()
  const token = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error("fixture-secret"), {
        code: "needs_login",
        status: 401,
      })
    )
  await expect(
    createChatgptStreamChat({ getAccessToken: token, fetch: fetchFn })(params)
  ).rejects.toMatchObject({ code: "needs_login", status: 401 })
  expect(token).toHaveBeenCalledTimes(1)
  expect(fetchFn).not.toHaveBeenCalled()
})

it("invalid_user e dois 401 persistem needs_login pelo hook", async () => {
  for (const code of ["subscription_sharing_invalid_user", "other"]) {
    const markNeedsLogin = vi.fn(async () => undefined)
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ error: { code } }), { status: 401 })
      )
    await expect(
      createChatgptStreamChat({
        getAccessToken: async () => "fixture-access",
        fetch: fetchFn,
        markNeedsLogin,
      })(params)
    ).rejects.toBeInstanceOf(ChatgptProviderError)
    expect(markNeedsLogin).toHaveBeenCalledTimes(1)
  }
})

it("texto terminal sem deltas é entregue uma vez", async () => {
  const sse = fixture("text").slice(
    fixture("text").indexOf("event: response.completed")
  )
  const onDelta = vi.fn()
  const result = await createChatgptStreamChat({
    getAccessToken: async () => "fixture-access",
    fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(sse)),
  })(params, { onDelta })
  expect(result.message.content).toBe("Hello")
  expect(onDelta).toHaveBeenCalledExactlyOnceWith("Hello")
})

it.each(["fetch", "stream", "backoff"])(
  "cancela durante %s em até 2s, mesmo com transporte não cooperativo",
  async (phase) => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const cancel = new DOMException("Cancelled", "AbortError")
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (phase === "fetch") return await new Promise<Response>(() => undefined)
      if (phase === "backoff") return new Response("{}", { status: 502 })
      return new Response(
        new ReadableStream<Uint8Array>({ start: () => undefined })
      )
    })
    const work = createChatgptStreamChat({
      getAccessToken: async () => "fixture-access",
      fetch: fetchFn,
    })({ ...params, signal: controller.signal })
    const rejected = expect(work).rejects.toBe(cancel)
    await vi.advanceTimersByTimeAsync(1)
    controller.abort(cancel)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(fetchFn).toHaveBeenCalledTimes(1)
  }
)

it("prazo absoluto encerra stream silencioso sem retry", async () => {
  vi.useFakeTimers()
  const work = createChatgptStreamChat({
    getAccessToken: async () => "fixture-access",
    fetch: vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new ReadableStream<Uint8Array>())),
  })({ ...params, deadlineAtMs: Date.now() + 10 })
  const rejected = expect(work).rejects.toMatchObject({ name: "TimeoutError" })
  await vi.advanceTimersByTimeAsync(10)
  await rejected
})

it.each([
  [
    "response.incomplete",
    { incomplete_details: { reason: "max_output_tokens" } },
    "length",
  ],
  [
    "response.completed",
    {
      output: [
        {
          type: "message",
          content: [{ type: "refusal", refusal: "Cannot assist" }],
        },
      ],
    },
    "content_filter",
  ],
])(
  "adaptador entrega %s com finishReason e usage sem retry",
  async (event, terminal, finishReason) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify({ response: { ...terminal, usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 } } })}\n\n`
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(frame))
    const result = await createChatgptStreamChat({
      getAccessToken: async () => "fixture-access",
      fetch: fetchFn,
    })(params)
    expect(result.finishReason).toBe(finishReason)
    expect(result.usage).toMatchObject({ totalTokens: 8, costKind: "plan" })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  }
)


it("não entrega tools de resposta cortada, limitada ou recusada para execução", async () => {
  const item = { type: "function_call", call_id: "partial_call", name: "write", arguments: "{}" };
  for (const reason of ["incomplete", "length", "content_filter"]) {
    const frame = `event: response.output_item.done\ndata: ${JSON.stringify({ item, output_index: 0 })}\n\n` + (reason === "incomplete" ? "" : `event: response.incomplete\ndata: ${JSON.stringify({ response: { output: [item], incomplete_details: { reason: reason === "length" ? "max_output_tokens" : "content_filter" } } })}\n\n`);
    const result = await createChatgptStreamChat({ getAccessToken: async () => "fixture-access", fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(frame)) })(params);
    expect(result.finishReason).toBe(reason);
    expect(result.message.tool_calls).toBeUndefined();
  }
});

describe("backend do plano ChatGPT (login por código)", () => {
  it("com conta: chama chatgpt.com/backend-api/codex com ChatGPT-Account-ID e instructions não vazio", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response())
    await createChatgptStreamChat({
      getAccessToken: async () => "codex-access",
      getAccountId: async () => "acct-123",
      fetch: fetchFn,
    })(params)
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses")
    const headers = new Headers(init?.headers)
    expect(headers.get("Authorization")).toBe("Bearer codex-access")
    expect(headers.get("ChatGPT-Account-ID")).toBe("acct-123")
    const body = JSON.parse(String(init?.body))
    expect(body.instructions).toBeTruthy()
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
  })
  it("sem conta (SIWC loopback) continua em api.openai.com", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response())
    await createChatgptStreamChat({ getAccessToken: async () => "t", getAccountId: async () => null, fetch: fetchFn })(params)
    expect(fetchFn.mock.calls[0]![0]).toBe("https://api.openai.com/v1/responses")
    expect(new Headers(fetchFn.mock.calls[0]![1]?.headers).has("ChatGPT-Account-ID")).toBe(false)
  })
})
