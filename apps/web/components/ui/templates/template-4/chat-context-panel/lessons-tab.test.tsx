import React from "react"
Object.assign(globalThis, { React })
import assert from "node:assert/strict"
import { test } from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { LessonView } from "@workspace/shared"
import { LESSONS_EMPTY, LessonsView } from "./lessons-tab"
import { groupLessons, lessonCounters, lessonEvidenceText, lessonOriginLabel } from "./lessons-tab-helpers"

const NOW = new Date("2026-10-20T12:00:00.000Z")
const base: LessonView = {
  id: "l1", ref: "Ll1", scope: "bot", scopeKey: null, content: "Ao enviar relatório, confirme o destinatário — porque já houve engano", origin: "correction",
  evidence: { source: "user", quote: "não era para o Pedro, era para o João", runId: "run-1" }, helpful: 3, harmful: 1, uses: 5, status: "active", version: 1, supersedesId: null, canRestore: false,
  createdAt: "2026-10-19T12:00:00.000Z", updatedAt: "2026-10-19T12:00:00.000Z", lastUsedAt: null,
}
const noop = async () => null
const view = (lessons: LessonView[], extra: Partial<React.ComponentProps<typeof LessonsView>> = {}) =>
  renderToStaticMarkup(<LessonsView lessons={lessons} now={NOW} onEdit={noop} onRemove={noop} onRestore={noop} {...extra} />)

test("agrupa por escopo: geral do bot primeiro, depois conectores com o nome e ferramentas", () => {
  const html = view(
    [
      { ...base, id: "l2", scope: "connector", scopeKey: "mcp:c1", content: "Ao listar, use o id interno — porque o de exibição falha", origin: "failure_recovery" },
      base,
      { ...base, id: "l3", scope: "tool", scopeKey: "mcp__erp__create_order", content: "Ao criar pedido, informe o prazo — porque o ERP recusa", origin: "failed_action" },
    ],
    { names: { "mcp:c1": "Loja" } },
  )
  assert.match(html, /data-lessons-tab/)
  assert.ok(html.indexOf("Geral do bot") < html.indexOf("Conector · Loja"))
  assert.ok(html.indexOf("Conector · Loja") < html.indexOf("Ferramenta · create_order"))
  assert.equal((html.match(/data-lessons-section=/g) ?? []).length, 3)
  assert.equal((html.match(/data-lesson-item=/g) ?? []).length, 3)
  assert.doesNotMatch(html, /Atlas/)
})

test("cada lição mostra o texto, a origem, os contadores discretos e as ações; o botão do cabeçalho é só ícone no celular", () => {
  const html = view([base])
  assert.match(html, /confirme o destinatário/)
  assert.match(html, /Você corrigiu/)
  assert.match(html, /Ajudou 3 · Atrapalhou 1 · Usada 5 vezes/)
  assert.match(html, /aria-label="Ações da lição"/)
  assert.match(html, /aria-label="Atualizar"/)
  assert.match(html, /max-md:hidden/)
})

test("a evidência fica recolhida por padrão e aparece expandida com a citação", () => {
  const closed = view([base])
  assert.match(closed, /Por que o bot aprendeu isto/)
  assert.doesNotMatch(closed, /não era para o Pedro, era para o João/)
  const open = view([base], { evidenceOpen: true })
  assert.match(open, /data-lesson-evidence/)
  assert.match(open, /O que você disse/)
  assert.match(open, /não era para o Pedro, era para o João/)
})

test("lição editada mostra a versão e, com versão anterior, o menu oferece restaurar (o texto do item vem do menu aberto no cliente)", () => {
  const html = view([{ ...base, version: 3, canRestore: true, supersedesId: "l0" }])
  assert.match(html, /versão 3/)
})

test("sem lições mostra o estado vazio; erro aparece como alerta", () => {
  const html = view([], { error: "Não foi possível carregar as lições." })
  assert.match(html, /data-lessons-empty/)
  assert.ok(html.includes(LESSONS_EMPTY.slice(0, 40)))
  assert.match(html, /role="alert"/)
})

test("helpers: rótulos de origem, contadores e evidência", () => {
  assert.equal(lessonOriginLabel("failure_recovery"), "Erro que se resolveu")
  assert.equal(lessonOriginLabel("user"), "Você pediu")
  assert.equal(lessonCounters({ helpful: 0, harmful: 0, uses: 0 }), null)
  assert.equal(lessonCounters({ helpful: 0, harmful: 0, uses: 1 }), "Usada 1 vez")
  assert.equal(lessonEvidenceText(null), null)
  assert.deepEqual(lessonEvidenceText({ source: "outcome", quote: "400 id inválido" }), { kind: "O que aconteceu na execução", quote: "400 id inválido" })
  assert.deepEqual(groupLessons([]), [])
  assert.equal(groupLessons([{ ...base, scope: "connector", scopeKey: "api:x" }])[0]!.title, "Conector · sem nome")
})
