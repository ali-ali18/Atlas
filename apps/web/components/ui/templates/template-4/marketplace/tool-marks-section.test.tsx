import React from "react"
Object.assign(globalThis, { React })
import assert from "node:assert/strict"
import { test } from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { McpConnectionView } from "@workspace/shared"
import { ToolMarksSection } from "./tool-marks-section"
import { toolIsRead } from "./tool-permissions"

const schema = { type: "object", properties: {} }
const erp = {
  id: "c1", catalogId: null, slug: "agroervas", name: "Agroervas", url: "https://erp.example/mcp", authType: "none", status: "connected",
  tools: [
    { name: "listar_pedidos", description: "Consulta de pedidos", inputSchema: schema },
    { name: "criar_pedido", description: "Cria pedido", inputSchema: schema },
    { name: "ping", inputSchema: schema, annotations: { readOnlyHint: true } },
  ],
  disabledTools: [], confirmWrites: true, lastError: null, accountLabel: null, createdAt: "", updatedAt: "",
} as unknown as McpConnectionView

test("recolhida por padrão: só o gatilho com o selo de sugestões pendentes", () => {
  const html = renderToStaticMarkup(<ToolMarksSection connection={erp} onChanged={() => undefined} />)
  assert.match(html, /Consultas sem aprovação/)
  assert.match(html, /1 sugestão/)
  assert.doesNotMatch(html, /role="switch"/)
})

test("aberta: um Switch 'Só leitura' por ferramenta sem anotação, sugestão pré-marcada, rótulo sem nome interno e botão Confirmar", () => {
  const html = renderToStaticMarkup(<ToolMarksSection connection={erp} defaultOpen onChanged={() => undefined} />)
  assert.match(html, /Listar pedidos/)
  const visible = html.replace(/<[^>]*>/g, " ")
  assert.doesNotMatch(visible, /listar_pedidos|criar_pedido/)
  assert.doesNotMatch(visible, /Ping/)
  assert.equal((html.match(/role="switch"/g) ?? []).length, 2)
  assert.match(html, /aria-label="Só leitura: Listar pedidos"[^>]*aria-checked="true"|aria-checked="true"[^>]*aria-label="Só leitura: Listar pedidos"/)
  assert.match(html, /aria-label="Só leitura: Criar pedido"[^>]*aria-checked="false"|aria-checked="false"[^>]*aria-label="Só leitura: Criar pedido"/)
  assert.match(html, />Confirmar</)
  assert.match(html, /só vale depois que você confirmar/)
})

test("depois de confirmado não há Confirmar; sem tool editável a seção some", () => {
  const confirmed = { ...erp, toolMarks: { listar_pedidos: "read", criar_pedido: "write" } } as McpConnectionView
  const html = renderToStaticMarkup(<ToolMarksSection connection={confirmed} defaultOpen onChanged={() => undefined} />)
  assert.doesNotMatch(html, />Confirmar</)
  assert.doesNotMatch(html, /sugest/)
  const allAnnotated = { ...erp, tools: [erp.tools[2]!] } as McpConnectionView
  assert.equal(renderToStaticMarkup(<ToolMarksSection connection={allAnnotated} onChanged={() => undefined} />), "")
})

test("a lista de permissões mostra 'leitura' só para anotada ou confirmada pelo dono", () => {
  assert.equal(toolIsRead(erp, erp.tools[0]!), false)
  assert.equal(toolIsRead({ ...erp, toolMarks: { listar_pedidos: "read" } }, erp.tools[0]!), true)
  assert.equal(toolIsRead(erp, erp.tools[2]!), true)
})

test("ferramenta irreversível: switch desabilitado e motivo visível; não conta como sugestão", () => {
  const withSend = { ...erp, tools: [...erp.tools, { name: "enviar_nfe", description: "Consulta e envia a nota", inputSchema: schema }] } as unknown as McpConnectionView
  const html = renderToStaticMarkup(<ToolMarksSection connection={withSend} defaultOpen onChanged={() => undefined} />)
  assert.match(html, /Sempre pede aprovação: ação que não dá para desfazer/)
  assert.match(html, /1 sugestão/)
  assert.match(html, /aria-label="Só leitura: Enviar nfe"[^>]*disabled|disabled[^>]*aria-label="Só leitura: Enviar nfe"/)
})

test("marca que o servidor invalidou mostra 'mudou, confirme de novo' e volta a ser sugestão pendente", () => {
  const changed = { ...erp, toolMarks: {}, staleToolMarks: ["listar_pedidos"] } as McpConnectionView
  const html = renderToStaticMarkup(<ToolMarksSection connection={changed} defaultOpen onChanged={() => undefined} />)
  assert.match(html, /O conector mudou esta ferramenta: confirme de novo/)
  assert.equal((html.match(/data-tool-mark-changed/g) ?? []).length, 1)
  assert.match(html, />Confirmar</)
  const fresh = renderToStaticMarkup(<ToolMarksSection connection={erp} defaultOpen onChanged={() => undefined} />)
  assert.doesNotMatch(fresh, /mudou esta ferramenta/)
})
