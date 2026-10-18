import type { FinishReason } from "@workspace/shared"
import { abortable } from "../decision-budget.js"
import { ChatgptProviderError, chatgptErrorFrom } from "./errors.js"
import type { ResponseItem } from "./to-responses.js"

const object = (value: unknown): ResponseItem => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ChatgptProviderError(502, "invalid_stream")
  return value as ResponseItem
}

/** Eventos nomeados Responses; termina no evento terminal, mesmo em keep-alive. */
export async function readResponsesSse(
  body: ReadableStream<Uint8Array>,
  handlers: {
    onDelta?: (text: string) => void
    onUseful?: () => void
  },
  signal?: AbortSignal
): Promise<{ text: string; output: ResponseItem[]; finishReason: FinishReason; model: string | undefined; usage: unknown }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let text = ""
  const items = new Map<number, ResponseItem>()
  let terminal: ResponseItem | undefined
  let finishReason: FinishReason = "incomplete"
  let refused = false
  const handle = (frame: string) => {
    const data: string[] = []
    let eventName = ""
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim()
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
    }
    if (!data.length || data.join("\n") === "[DONE]") return
    let event: ResponseItem
    try {
      event = object(JSON.parse(data.join("\n")))
    } catch {
      throw new ChatgptProviderError(502, "invalid_stream")
    }
    const type = typeof event.type === "string" ? event.type : eventName
    if (type === "error") throw chatgptErrorFrom(event, 502)
    if (type === "response.failed") throw chatgptErrorFrom(event.response, 502)
    if (type === "response.incomplete") {
      terminal = object(event.response)
      const details = terminal.incomplete_details
      const reason =
        details !== null && typeof details === "object" && "reason" in details
          ? details.reason
          : undefined
      finishReason =
        reason === "max_output_tokens"
          ? "length"
          : reason === "content_filter"
            ? "content_filter"
            : "incomplete"
      handlers.onUseful?.()
      return
    }
    if (type === "response.refusal.delta" || type === "response.refusal.done") {
      refused = true
      handlers.onUseful?.()
    }
    if (
      type === "response.output_text.delta" &&
      typeof event.delta === "string"
    ) {
      text += event.delta
      handlers.onUseful?.()
      handlers.onDelta?.(event.delta)
    } else if (
      /^response\.(?:reasoning.*delta|function_call_arguments\.delta|output_item\.(?:added|done))$/.test(
        type
      )
    ) {
      handlers.onUseful?.()
      if (type === "response.output_item.done") {
        const index =
          typeof event.output_index === "number"
            ? event.output_index
            : items.size
        items.set(index, object(event.item))
      }
    } else if (type === "response.completed") {
      handlers.onUseful?.()
      terminal = object(event.response)
      finishReason = "stop"
    }
  }
  try {
    while (!terminal) {
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await abortable(reader.read(), signal)
      } catch {
        signal?.throwIfAborted()
        break
      }
      const { done, value } = chunk
      if (done) {
        buffer += decoder.decode()
        if (buffer.trim()) handle(buffer)
        break
      }
      buffer += decoder.decode(value, { stream: true })
      // Um item pode conter documento longo, mas um frame não pode crescer sem limite.
      if (buffer.length > 16_000_000)
        throw new ChatgptProviderError(502, "invalid_stream")
      let separator: RegExpExecArray | null
      while (!terminal && (separator = /\r?\n\r?\n/.exec(buffer))) {
        handle(buffer.slice(0, separator.index))
        buffer = buffer.slice(separator.index + separator[0].length)
      }
    }
    const response = terminal ?? {}
    const output =
      Array.isArray(response.output) && response.output.length
        ? response.output.map(object)
        : [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)
    if (!text) {
      text = output
        .filter(
          (item) => item.type === "message" && Array.isArray(item.content)
        )
        .flatMap((item) => item.content as unknown[])
        .map((part) => {
          const raw = object(part)
          return raw.type === "output_text" && typeof raw.text === "string"
            ? raw.text
            : ""
        })
        .join("")
      if (text) handlers.onDelta?.(text)
    }
    if (
      refused ||
      output.some(
        (item) =>
          item.type === "message" &&
          Array.isArray(item.content) &&
          item.content.some(
            (part) =>
              part !== null &&
              typeof part === "object" &&
              "type" in part &&
              part.type === "refusal"
          )
      )
    ) {
      finishReason = "content_filter"
    }
    return {
      text,
      output,
      finishReason,
      model: typeof response.model === "string" ? response.model : undefined,
      usage: response.usage,
    }
  } finally {
    try {
      void reader.cancel().catch(() => undefined)
    } catch {
      /* Já encerrado. */
    }
    try {
      reader.releaseLock()
    } catch {
      /* Cancelamento em andamento. */
    }
  }
}
