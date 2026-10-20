import React from "react"
Object.assign(globalThis, { React })
import assert from "node:assert/strict"
import { test } from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { EffectiveAutonomy, McpConnectionView, McpToolInfo } from "@workspace/shared"
import { ToolPermissionControl } from "./tool-permission-control"
import { ToolPermissionList } from "./tool-permission-list"
import { connectionPermission, toolPermission, withAllToolsPermission, withToolPermission } from "./tool-permissions"

const read: McpToolInfo = { name: "list_items", inputSchema: {}, annotations: { readOnlyHint: true } }
const write: McpToolInfo = { name: "create_item", inputSchema: {} }
const remove: McpToolInfo = { name: "delete_item", inputSchema: {} }
const connection = { catalogId: null, slug: "demo", tools: [read, write, remove], disabledTools: [] as string[] }
const balanced: EffectiveAutonomy = { level: "balanced", exceptions: [] }

test("sem exceção: padrão do nível (leitura permite, escrita pergunta)", () => {
  assert.equal(toolPermission(connection, read, balanced), "never_ask")
  assert.equal(toolPermission(connection, write, balanced), "always_ask")
  assert.equal(toolPermission(connection, write, { level: "autonomous", exceptions: [] }), "never_ask")
})

test("exceção vence o padrão; tool vence conector; disabledTools aparece como Bloquear", () => {
  const policy: EffectiveAutonomy = {
    level: "balanced",
    exceptions: [{ tool: "mcp__demo__create_item", mode: "never_ask" }, { connector: "demo", mode: "blocked" }],
  }
  assert.equal(toolPermission(connection, write, policy), "never_ask")
  assert.equal(toolPermission(connection, read, policy), "blocked")
  assert.equal(toolPermission({ ...connection, disabledTools: ["create_item"] }, write, balanced), "blocked")
})

test("todas: um valor comum ou Personalizado; definir todas limpa as exceções por tool", () => {
  assert.equal(connectionPermission(connection, balanced), "mixed")
  const exceptions = withToolPermission([], connection, write, "never_ask")
  const all = withAllToolsPermission(exceptions, connection, "always_ask")
  assert.deepEqual(all, [{ connector: "demo", mode: "always_ask" }])
  assert.equal(connectionPermission(connection, { level: "balanced", exceptions: all }), "always_ask")
  assert.equal(connectionPermission(connection, { level: "balanced", exceptions }), "mixed")
})

test("controle: grupo desktop com 3 botões, o atual pressionado; gatilho mobile com o rótulo", () => {
  const html = renderToStaticMarkup(<ToolPermissionControl name="criar" onChange={() => {}} value="always_ask" />)
  assert.match(html, /aria-label="Permitir sempre"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*aria-label="Permitir sempre"/)
  assert.match(html, /aria-label="Bloquear"/)
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1)
  assert.match(html, /hidden md:flex/)
  assert.match(html, /md:hidden/)
  assert.match(html, />Perguntar</)
  assert.match(renderToStaticMarkup(<ToolPermissionControl name="x" onChange={() => {}} value="mixed" />), />Personalizado</)
  assert.match(renderToStaticMarkup(<ToolPermissionControl name="x" onChange={() => {}} value="blocked" />), />Bloquear</)
  assert.doesNotMatch(html, /Atlas/)
})

test("lista: linha de todas, badge, guia e um controle por tool", () => {
  const view = { ...connection, id: "c1", name: "Demo", status: "connected" } as unknown as McpConnectionView
  const html = renderToStaticMarkup(
    <ToolPermissionList connection={view} onAllChange={() => {}} onOpenGuide={() => {}} onToolChange={() => {}} policy={balanced} />,
  )
  assert.match(html, /Definir para todas as ferramentas/)
  assert.match(html, />Personalizado</)
  assert.match(html, /leitura/)
  assert.match(html, /escreve/)
  assert.match(html, /aria-label="Guia da ferramenta create_item"/)
  assert.equal((html.match(/data-tool-permission(?!-)/g) ?? []).length, 4)
  assert.equal((html.match(/flex items-center justify-between gap-3 p-3/g) ?? []).length, 4)
})
