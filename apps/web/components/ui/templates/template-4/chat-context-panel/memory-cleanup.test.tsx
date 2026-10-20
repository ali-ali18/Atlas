import React from "react"
Object.assign(globalThis, { React })
import assert from "node:assert/strict"
import { test } from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { MemoryCleanupView } from "@workspace/shared"
import { MemoryCleanupBlock } from "./memory-cleanup"

const view: MemoryCleanupView = {
  suggestions: [
    { id: "s1", kind: "delete", target: "memory", entryIds: ["e1"], before: ["Reunião de hoje remarcada"], reason: "Tarefa já encerrada", createdAt: "2026-10-20T12:00:00.000Z" },
    { id: "s2", kind: "merge", target: "user", entryIds: ["e2", "e3"], before: ["Prefere planilha", "Gosta de xlsx"], content: "Prefere planilha (xlsx)", reason: "Mesmo assunto", createdAt: "2026-10-20T12:00:00.000Z" },
  ],
  status: null,
  error: null,
  requestedAt: null,
}

test("sem sugestões: só o botão Revisar memórias com tooltip/rótulo; sem lista", () => {
  const html = renderToStaticMarkup(<MemoryCleanupBlock cleanup={{ suggestions: [], status: null, error: null, requestedAt: null }} />)
  assert.match(html, /aria-label="Revisar memórias"/)
  assert.doesNotMatch(html, /Sugestões de limpeza/)
  assert.doesNotMatch(html, /Atlas/)
})

test("fechado mostra o título e a contagem; aberto lista motivo, texto atual e o texto fundido", () => {
  const closed = renderToStaticMarkup(<MemoryCleanupBlock cleanup={view} />)
  assert.match(closed, /Sugestões de limpeza/)
  assert.match(closed, />2</)
  assert.doesNotMatch(closed, /Tarefa já encerrada/)
  const open = renderToStaticMarkup(<MemoryCleanupBlock cleanup={view} open />)
  assert.match(open, /Motivo: Tarefa já encerrada/)
  assert.match(open, /Reunião de hoje remarcada/)
  assert.match(open, /Juntar 2 memórias/)
  assert.match(open, /Prefere planilha \(xlsx\)/)
  assert.equal((open.match(/aria-label="Aplicar"/g) ?? []).length, 2)
  assert.equal((open.match(/aria-label="Ignorar"/g) ?? []).length, 2)
  assert.match(open, />Aplicar todas</)
})

test("uma só sugestão não oferece Aplicar todas; confirmação mostra o alerta", () => {
  const one = renderToStaticMarkup(<MemoryCleanupBlock cleanup={{ ...view, suggestions: [view.suggestions[0]!] }} open />)
  assert.doesNotMatch(one, />Aplicar todas</)
  const confirm = renderToStaticMarkup(<MemoryCleanupBlock cleanup={view} confirmAll open />)
  assert.match(confirm, /Aplicar as 2 sugestões\?/)
})

test("revisando desabilita o botão e avisa; falha e erro aparecem como alerta", () => {
  const generating = renderToStaticMarkup(<MemoryCleanupBlock cleanup={{ suggestions: [], status: "generating", error: null, requestedAt: "2026-10-20T12:00:00.000Z" }} />)
  assert.match(generating, /Revisando as memórias…/)
  assert.match(generating, /<button[^>]*disabled[^>]*aria-label="Revisar memórias"|<button[^>]*aria-label="Revisar memórias"[^>]*disabled/)
  const failed = renderToStaticMarkup(<MemoryCleanupBlock cleanup={{ suggestions: [], status: "failed", error: "Sem chave de modelo", requestedAt: null }} />)
  assert.match(failed, /role="alert"[^>]*>Sem chave de modelo/)
  assert.match(renderToStaticMarkup(<MemoryCleanupBlock cleanup={null} nothing />), /Nada para limpar\./)
})
