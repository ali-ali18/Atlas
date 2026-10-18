import { readFileSync } from "node:fs"
import { expect, it, vi } from "vitest"
import { readResponsesSse } from "./sse.js"
import { ChatgptProviderError } from "./errors.js"

it("lê frames nomeados CRLF fragmentados byte a byte, comentários e Unicode", async () => {
  const text =
    ': heartbeat\r\n\r\nevent: response.output_text.delta\r\ndata: {"delta":"ação"}\r\n\r\nevent: response.completed\r\ndata: {"response":{"model":"luna","output":[]}}\r\n\r\n'
  const bytes = new TextEncoder().encode(text)
  const onDelta = vi.fn()
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index))
      else controller.close()
    },
  })
  const result = await readResponsesSse(stream, { onDelta })
  expect(result.text).toBe("ação")
  expect(onDelta).toHaveBeenCalledExactlyOnceWith("ação")
})

it("termina no completed e libera reader mesmo com conexão que fica aberta", async () => {
  const cancel = vi.fn()
  const fixture = readFileSync(
    new URL("./__fixtures__/text.sse", import.meta.url),
    "utf8"
  )
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(fixture))
    },
    cancel,
  })
  expect((await readResponsesSse(stream, {})).text).toBe("Hello")
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(stream.locked).toBe(false)
})

it.each([
  [
    'event: error\ndata: {"code":"subscription_sharing_unsupported_capability","message":"fixture-secret"}\n\n',
    "subscription_sharing_unsupported_capability",
  ],
  ["event: response.completed\ndata: invalid json\n\n", "invalid_stream"],
])(
  "não aceita falha/incomplete/malformed como resposta vazia",
  async (text, code) => {
    await expect(
      readResponsesSse(new Response(text).body!, {})
    ).rejects.toMatchObject({ code })
  }
)

it("código herdado de Object não vira código externo ou regra fatal", () => {
  expect(new ChatgptProviderError(502, "constructor").code).toBe(
    "upstream_error"
  )
})

it.each([
  ["response.completed", {}, "stop"],
  [
    "response.incomplete",
    { incomplete_details: { reason: "max_output_tokens" } },
    "length",
  ],
  [
    "response.incomplete",
    { incomplete_details: { reason: "content_filter" } },
    "content_filter",
  ],
  [
    "response.incomplete",
    { incomplete_details: { reason: "other" } },
    "incomplete",
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
  "mapeia %s ao término explícito L18",
  async (event, response, finishReason) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify({ response })}\n\n`
    expect(
      (await readResponsesSse(new Response(frame).body!, {})).finishReason
    ).toBe(finishReason)
  }
)

it("stream cortado mantém texto parcial e término incomplete", async () => {
  const frame =
    'event: response.output_text.delta\ndata: {"delta":"partial"}\n\n'
  expect(await readResponsesSse(new Response(frame).body!, {})).toMatchObject({
    text: "partial",
    finishReason: "incomplete",
  })
})

it("erro de leitura conserva término incomplete, sem mascarar cancelamento", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("fixture"))
    },
  })
  expect((await readResponsesSse(body, {})).finishReason).toBe("incomplete")
})


it("cancelamento do pai não vira resposta incomplete", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Cancelled", "AbortError");
  controller.abort(reason);
  const body = new ReadableStream<Uint8Array>();
  await expect(readResponsesSse(body, {}, controller.signal)).rejects.toBe(reason);
});
