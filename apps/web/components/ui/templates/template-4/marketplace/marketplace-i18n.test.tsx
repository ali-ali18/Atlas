import React from "react"
Object.assign(globalThis, { React })
import assert from "node:assert/strict"
import { test } from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ApiOperation, McpToolInfo } from "@workspace/shared"
import { loadMessages } from "@/lib/i18n/messages"
import { I18nProvider } from "@/lib/i18n/provider"
import { createTranslator } from "@/lib/i18n/translator"
import { apiOperationGuide, mcpToolGuide, schemaTypeLabel, ToolGuideBody } from "./tool-guide"
import { ConnectorGuideBlock } from "./connector-guide"
import { ToolPermissionControl } from "./tool-permission-control"
import { SkillsListView } from "./catalog-views"
import { connectorAction } from "./connector-action"
import { connectorStatusLabel, diffLabel, scopeOptions } from "./catalog-state"
import { apiAccessSummary } from "./api-connections-section"
import { ApiLinkStep } from "./api-manual-connect"

async function wrap(locale: "en-US" | "es-ES", node: React.ReactNode) {
  return renderToStaticMarkup(<I18nProvider locale={locale} messages={await loadMessages(locale)}>{node}</I18nProvider>)
}

const tool: McpToolInfo = {
  name: "search_pages",
  title: "Search",
  description: "Finds pages.",
  annotations: { readOnlyHint: true },
  inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, ids: { type: "array", items: { type: "integer" } } } },
}

test("guia da ferramenta em en-US e es-ES", async () => {
  const en = createTranslator("en-US", await loadMessages("en-US"))
  const guide = mcpToolGuide(tool, en)
  assert.equal(guide.access, "Read")
  assert.deepEqual(guide.params.map((param) => param.type), ["text", "list of whole number"])
  assert.equal(schemaTypeLabel({ enum: ["a", "b"] }, en), "one of: a, b")
  const html = await wrap("en-US", <ToolGuideBody guide={guide} onClose={() => undefined} />)
  assert.match(html, /Parameters/)
  assert.match(html, /required/)
  assert.match(html, />Close</)
  assert.doesNotMatch(html, /Parâmetros|obrigatório|Fechar/)
  const es = createTranslator("es-ES", await loadMessages("es-ES"))
  const operation: ApiOperation = { id: "get", method: "POST", path: "/x", summary: "S", tag: "T", body: true, params: [] }
  assert.match(apiOperationGuide(operation, es).note ?? "", /llegarán pronto/)
})

test("guia de uso do conector e controle de permissão no idioma da tela", async () => {
  const guide = { status: "ready", source: "user", text: "Use the id.", suggestions: [], updatedAt: "2026-01-01T00:00:00Z" } as never
  const html = await wrap("en-US", <ConnectorGuideBlock guide={guide} open />)
  assert.match(html, /Usage guide/)
  assert.match(html, /Edited by you/)
  assert.match(html, /The bot reads this guide as supporting data/)
  assert.doesNotMatch(html, /Guia de uso|Editado por você/)
  const control = await wrap("es-ES", <ToolPermissionControl name="Buscar" onChange={() => undefined} value="always_ask" />)
  assert.match(control, /aria-label="Permiso de Buscar"/)
  assert.match(control, /Preguntar/)
})

test("lista de habilidades do catálogo em en-US", async () => {
  const html = await wrap(
    "en-US",
    <SkillsListView all={[]} category="" error={null} loading={false} onCategory={() => undefined} onInstall={() => undefined} onOpen={() => undefined} skills={[]} />,
  )
  assert.match(html, /Community skills/)
  assert.match(html, /No skills found\./)
  assert.doesNotMatch(html, /Habilidades da comunidade/)
})

test("textos puros do marketplace recebem o tradutor", async () => {
  const en = createTranslator("en-US", await loadMessages("en-US"))
  const es = createTranslator("es-ES", await loadMessages("es-ES"))
  assert.equal(connectorAction({ connection: undefined, secretBoxReady: true, busy: false, translator: en }).label, "Add")
  assert.equal(connectorAction({ secretBoxReady: true, busy: true, translator: es }).label, "Conectando…")
  assert.equal(diffLabel(1, 3, en), "1 new line · 3 removed")
  assert.equal(diffLabel(0, 0, en), "0 new lines · 0 removed")
  assert.equal(connectorStatusLabel(false, es), "Conectar después")
  assert.equal(scopeOptions([], [], en)[0]?.label, "My account")
  assert.equal(apiAccessSummary({ groups: [], allowedTags: [] }, en), "Read-only · 0 of 0 groups")
})

test("passo do link da API e rótulos de conta em en-US", async () => {
  const html = await wrap("en-US", <ApiLinkStep busy={false} onCancel={() => undefined} onChange={() => undefined} onSubmit={() => undefined} value="" />)
  assert.match(html, /API link/)
  assert.match(html, /Paste the link to the documentation/)
  assert.match(html, />Continue</)
})
