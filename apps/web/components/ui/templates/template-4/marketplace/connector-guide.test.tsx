import React from "react"
Object.assign(globalThis, { React })
import assert from "node:assert/strict"
import { test } from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ConnectorGuideView } from "@workspace/shared"
import { ConnectorGuideBlock, GUIDE_PREVIEW_CHARS, guideNeedsExpand } from "./connector-guide"

const short: ConnectorGuideView = {
  text: "- Passe o id interno retornado pela listagem.\n- Datas em AAAA-MM-DD.",
  source: "generated",
  updatedAt: "2026-01-01T00:00:00.000Z",
  suggestions: [],
}
const long: ConnectorGuideView = { ...short, text: Array.from({ length: 12 }, (_, i) => `- Tópico ${i} com bastante texto para passar do limite`).join("\n") }

test("guia curto: texto renderizado, origem, ações, sem Ver tudo", () => {
  const html = renderToStaticMarkup(<ConnectorGuideBlock guide={short} />)
  assert.match(html, /Guia de uso/)
  assert.match(html, /Gerado automaticamente/)
  assert.match(html, /Passe o id interno/)
  assert.match(html, />Editar</)
  assert.match(html, />Gerar de novo</)
  assert.doesNotMatch(html, /Ver tudo/)
  assert.doesNotMatch(html, /Atlas/)
})

test("guia longo: recortado com Ver tudo; expandido mostra Ver menos", () => {
  assert.equal(guideNeedsExpand(short.text), false)
  assert.equal(guideNeedsExpand("x".repeat(GUIDE_PREVIEW_CHARS + 1)), true)
  const collapsed = renderToStaticMarkup(<ConnectorGuideBlock guide={long} />)
  assert.match(collapsed, /Ver tudo/)
  assert.match(collapsed, /max-h-24/)
  const open = renderToStaticMarkup(<ConnectorGuideBlock expanded guide={long} />)
  assert.match(open, /Ver menos/)
  assert.doesNotMatch(open, /max-h-24/)
})

test("editado pelo usuário mostra a origem; edição mostra textarea com contador e Salvar", () => {
  const edited = renderToStaticMarkup(<ConnectorGuideBlock guide={{ ...short, source: "user" }} />)
  assert.match(edited, /Editado por você/)
  const editing = renderToStaticMarkup(<ConnectorGuideBlock draft="- novo" editing guide={short} />)
  assert.match(editing, /<textarea/)
  assert.match(editing, /6 de 2000 caracteres/)
  assert.match(editing, />Salvar</)
  assert.match(editing, />Cancelar</)
  assert.doesNotMatch(editing, />Gerar de novo</)
})

test("sem guia: convida a gerar; gerando desabilita e avisa", () => {
  const empty = renderToStaticMarkup(<ConnectorGuideBlock guide={null} />)
  assert.match(empty, /ainda não foi gerado/)
  assert.match(empty, />Gerar guia</)
  assert.doesNotMatch(empty, />Editar</)
  const generating = renderToStaticMarkup(<ConnectorGuideBlock generating guide={null} />)
  assert.match(generating, /Gerando/)
})

test("sugestão do bot com Aceitar e Descartar; confirmação ao sobrescrever guia editado", () => {
  const html = renderToStaticMarkup(
    <ConnectorGuideBlock confirmRegenerate guide={{ ...short, source: "user", suggestions: [{ id: "s1", text: "Use o id interno.", createdAt: "2026-01-02T00:00:00.000Z" }] }} />
  )
  assert.match(html, /Sugestão do bot/)
  assert.match(html, /Use o id interno\./)
  assert.match(html, />Aceitar</)
  assert.match(html, />Descartar</)
  assert.match(html, /Substituir o guia editado\?/)
})
