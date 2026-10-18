import React from "react"
Object.assign(globalThis, { React })
import assert from "node:assert/strict"
import { test } from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ApiOperation, McpToolInfo } from "@workspace/shared"
import { apiOperationGuide, mcpToolGuide, schemaTypeLabel, ToolGuideBody } from "./tool-guide"

const tool: McpToolInfo = {
  name: "search_pages",
  title: "Buscar páginas",
  description: "Procura páginas pelo texto.\nRetorna até 20 resultados.",
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "Texto da busca" },
      limit: { type: "integer" },
      kind: { type: "string", enum: ["page", "database"] },
      ids: { type: "array", items: { type: "string" } },
    },
  },
}

test("tipos do JSON Schema em português", () => {
  assert.equal(schemaTypeLabel({ type: "string" }), "texto")
  assert.equal(schemaTypeLabel({ type: ["number", "null"] }), "número")
  assert.equal(schemaTypeLabel({ type: "array", items: { type: "string" } }), "lista de texto")
  assert.equal(schemaTypeLabel({ enum: ["a", "b"] }), "uma de: a, b")
  assert.equal(schemaTypeLabel({ anyOf: [{ type: "string" }, { type: "boolean" }] }), "texto ou sim ou não")
})

test("guia de tool MCP: título, leitura, parâmetros e obrigatório", () => {
  const guide = mcpToolGuide(tool)
  assert.equal(guide.title, "Buscar páginas")
  assert.equal(guide.access, "Leitura")
  assert.deepEqual(guide.params.map((param) => [param.name, param.type, param.required]), [
    ["query", "texto", true],
    ["limit", "número inteiro", false],
    ["kind", "uma de: page, database", false],
    ["ids", "lista de texto", false],
  ])
  const write = mcpToolGuide({ ...tool, annotations: { destructiveHint: true } })
  assert.equal(write.access, "Escrita · pode apagar")
  const html = renderToStaticMarkup(<ToolGuideBody guide={guide} onClose={() => undefined} />)
  assert.match(html, /Buscar páginas/)
  assert.match(html, /Retorna até 20 resultados/)
  assert.match(html, /obrigatório/)
  assert.match(html, />Fechar</)
})

test("guia de operação da API: método e caminho, parâmetros e aviso de só leitura", () => {
  const operation: ApiOperation = {
    id: "getPedido", method: "GET", path: "/pedidos/vendas/{id}", summary: "Obtém um pedido", tag: "Pedidos", body: false,
    params: [{ name: "id", in: "path", required: true, type: "integer", description: "Identificador" }, { name: "situacao", in: "query", required: false, type: "string", enum: ["aberto", "fechado"] }],
  }
  const guide = apiOperationGuide(operation)
  assert.equal(guide.code, "GET /pedidos/vendas/{id}")
  assert.equal(guide.access, "Leitura")
  assert.deepEqual(guide.params.map((param) => param.place), ["no caminho", "na consulta"])
  assert.equal(apiOperationGuide({ ...operation, method: "POST" }).access, "Escrita")
  assert.match(apiOperationGuide({ ...operation, method: "POST" }).note ?? "", /em breve/)
  const html = renderToStaticMarkup(<ToolGuideBody guide={guide} onClose={() => undefined} />)
  assert.match(html, /GET \/pedidos\/vendas\/\{id\}/)
  assert.match(html, /no caminho/)
})
