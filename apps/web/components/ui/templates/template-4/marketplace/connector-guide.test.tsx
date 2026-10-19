import React from "react"
Object.assign(globalThis, { React })
import assert from "node:assert/strict"
import { test } from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ConnectorGuideView } from "@workspace/shared"
import { ConnectorGuideBlock } from "./connector-guide"

const short: ConnectorGuideView = {
  text: "- Passe o id interno retornado pela listagem.\n- Datas em AAAA-MM-DD.",
  source: "generated",
  updatedAt: "2026-01-01T00:00:00.000Z",
  suggestions: [],
}
const long: ConnectorGuideView = { ...short, text: Array.from({ length: 12 }, (_, i) => `- Tópico ${i} com bastante texto para passar do limite`).join("\n") }

test("fechado: só o gatilho com título, origem e badge de sugestões; aberto mostra texto e ações", () => {
  const withSuggestion = { ...short, suggestions: [{ id: "s1", text: "Use o id.", createdAt: "2026-01-02T00:00:00.000Z" }] }
  const closed = renderToStaticMarkup(<ConnectorGuideBlock guide={withSuggestion} />)
  assert.match(closed, /Guia de uso/)
  assert.match(closed, /Gerado automaticamente/)
  assert.match(closed, /1 sugestão/)
  assert.doesNotMatch(closed, /Passe o id interno/)
  assert.doesNotMatch(closed, /Atlas/)
  const open = renderToStaticMarkup(<ConnectorGuideBlock guide={short} open />)
  assert.match(open, /Passe o id interno/)
  assert.match(open, /aria-label="Editar guia"/)
  assert.match(open, /aria-label="Gerar de novo"/)
  assert.doesNotMatch(open, />Editar</)
  assert.doesNotMatch(open, /Ver tudo/)
  assert.match(renderToStaticMarkup(<ConnectorGuideBlock guide={{ ...withSuggestion, suggestions: [withSuggestion.suggestions[0]!, { id: "s2", text: "Outra", createdAt: "2026-01-02T00:00:00.000Z" }] }} />), /2 sugestões/)
})

test("editado pelo usuário mostra a origem; edição mostra textarea com contador e Salvar", () => {
  const edited = renderToStaticMarkup(<ConnectorGuideBlock open guide={{ ...short, source: "user" }} />)
  assert.match(edited, /Editado por você/)
  const editing = renderToStaticMarkup(<ConnectorGuideBlock open draft="- novo" editing guide={short} />)
  assert.match(editing, /<textarea/)
  assert.match(editing, /6 de 2000 caracteres/)
  assert.match(editing, />Salvar</)
  assert.match(editing, />Cancelar</)
  assert.doesNotMatch(editing, /aria-label="Gerar de novo"/)
})

test("sem guia: convida a gerar; gerando desabilita e avisa", () => {
  const empty = renderToStaticMarkup(<ConnectorGuideBlock open guide={null} />)
  assert.match(empty, /ainda não foi gerado/)
  assert.match(empty, /aria-label="Gerar guia"/)
  assert.doesNotMatch(empty, /aria-label="Editar guia"/)
  const generating = renderToStaticMarkup(<ConnectorGuideBlock open generating guide={null} />)
  assert.match(generating, /Gerando/)
})

test("sugestão do bot com Aceitar e Descartar; confirmação ao sobrescrever guia editado", () => {
  const html = renderToStaticMarkup(
    <ConnectorGuideBlock open confirmRegenerate guide={{ ...short, source: "user", suggestions: [{ id: "s1", text: "Use o id interno.", createdAt: "2026-01-02T00:00:00.000Z" }] }} />
  )
  assert.match(html, /Sugestão do bot/)
  assert.match(html, /Use o id interno\./)
  assert.match(html, />Aceitar</)
  assert.match(html, />Descartar</)
  assert.match(html, /Substituir o guia editado\?/)
})
