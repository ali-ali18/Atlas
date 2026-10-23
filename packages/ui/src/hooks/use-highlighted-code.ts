import * as React from "react"

import { loadHighlighter } from "@workspace/ui/lib/highlighter"

/** What the incremental highlight needs from a highlighter (`loadHighlighter`). */
export type IncrementalHighlighter<S> = {
  highlight(code: string, state?: S): { lines: React.ReactNode[]; state?: S }
}

export type HighlightProgress<S> = {
  highlighter: IncrementalHighlighter<S> | null
  text: string
  lines: React.ReactNode[]
  state?: S
}

/**
 * Pure step of the incremental highlight: from what is already highlighted
 * (`done`), tokenizes only the newly completed lines of `code`. Returns `done`
 * itself when there is nothing new.
 */
export function advanceHighlight<S>(
  done: HighlightProgress<S>,
  code: string,
  highlighter: IncrementalHighlighter<S> | null
): HighlightProgress<S> {
  let next = done

  if (next.highlighter !== highlighter || !code.startsWith(next.text)) {
    next = { highlighter, text: "", lines: [] }
  }

  const end = code.lastIndexOf("\n") + 1

  if (highlighter && end > next.text.length) {
    const result = highlighter.highlight(
      code.slice(next.text.length, end - 1),
      next.state
    )

    next = {
      highlighter,
      text: code.slice(0, end),
      lines: [...next.lines, ...result.lines],
      state: result.state,
    }
  }

  return next
}

export function useHighlightedCode(value: string, language: string) {
  // A trailing newline would render as an extra empty line.
  const code = value.endsWith("\n") ? value.slice(0, -1) : value
  const [loaded, setLoaded] = React.useState<{
    language: string
    highlighter: Awaited<ReturnType<typeof loadHighlighter>>
  } | null>(null)
  const highlighter = loaded?.language === language ? loaded.highlighter : null

  React.useEffect(() => {
    let cancelled = false

    loadHighlighter(language)
      .then((next) => {
        if (!cancelled) {
          setLoaded({ language, highlighter: next })
        }
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [language])

  // The complete lines, highlighted. While the code streams, only the new
  // lines are tokenized, starting from the grammar state of the last one.
  type State = Parameters<NonNullable<typeof highlighter>["highlight"]>[1]
  const [done, setDone] = React.useState<HighlightProgress<State>>({
    highlighter: null,
    text: "",
    lines: [],
  })

  const next = advanceHighlight(done, code, highlighter)
  const end = code.lastIndexOf("\n") + 1

  // Saves the progress after the commit, not during render: the next render
  // starts from it (and computes the same `next`, so this settles).
  React.useEffect(() => {
    if (next !== done) setDone(next)
  }, [next, done])

  // The last line is still being written, so it is tokenized on every render.
  const tail = code.slice(end)

  return React.useMemo(() => {
    if (!highlighter) {
      return code.split("\n")
    }

    return [...next.lines, highlighter.highlight(tail, next.state).lines[0]]
  }, [code, highlighter, next, tail])
}
