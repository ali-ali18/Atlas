import { describe, expect, it } from "vitest"

import { advanceHighlight, type HighlightProgress, type IncrementalHighlighter } from "./use-highlighted-code"

function fakeHighlighter() {
  const calls: string[] = []
  const highlighter: IncrementalHighlighter<number> = {
    highlight(code, state = 0) {
      calls.push(code)
      const lines = code.split("\n")
      return { lines, state: state + lines.length }
    },
  }
  return { highlighter, calls }
}

const empty: HighlightProgress<number> = { highlighter: null, text: "", lines: [] }

describe("advanceHighlight", () => {
  it("tokeniza só as linhas novas completas e devolve o mesmo objeto sem novidade", () => {
    const { highlighter, calls } = fakeHighlighter()
    const first = advanceHighlight(empty, "a\nb\nc", highlighter)
    expect(first.text).toBe("a\nb\n")
    expect(first.lines).toEqual(["a", "b"])
    expect(advanceHighlight(first, "a\nb\nc!", highlighter)).toBe(first)
    const second = advanceHighlight(first, "a\nb\nc!\nd", highlighter)
    expect(second.lines).toEqual(["a", "b", "c!"])
    expect(second.state).toBe(3)
    expect(calls).toEqual(["a\nb", "c!"])
  })

  it("recomeça quando o código não continua o anterior ou o highlighter muda", () => {
    const { highlighter } = fakeHighlighter()
    const first = advanceHighlight(empty, "a\nb\n", highlighter)
    expect(advanceHighlight(first, "x\n", highlighter).lines).toEqual(["x"])
    const other = fakeHighlighter().highlighter
    expect(advanceHighlight(first, "a\nb\n", other).highlighter).toBe(other)
  })

  it("sem highlighter não tokeniza nada", () => {
    expect(advanceHighlight(empty, "a\nb\n", null)).toBe(empty)
  })
})
