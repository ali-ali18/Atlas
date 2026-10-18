import React from "react"
Object.assign(globalThis, { React })
import assert from "node:assert/strict"
import { test } from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ApiProposal } from "@workspace/shared"
import { ApiConnectFlow } from "@/components/ai-elements/login/api-connect-sheet"
import { ApiLinkStep } from "./api-manual-connect"
import { CustomConnectorForm } from "./custom-connector-form"

const noop = () => undefined
const link = (props: Partial<Parameters<typeof ApiLinkStep>[0]> = {}) =>
  renderToStaticMarkup(<ApiLinkStep busy={false} onCancel={noop} onChange={noop} onSubmit={noop} value="" {...props} />)

const proposal: ApiProposal = {
  specUrl: "https://developer.exemplo.test/openapi.json",
  name: "Exemplo API",
  domain: "api.exemplo.test",
  baseUrl: "https://api.exemplo.test/v3",
  authKind: "apiKey",
  operationCount: 3,
  readCount: 2,
  groups: [{ tag: "Pedidos", total: 3, read: 2, write: 1 }],
}

test("passo 'Link da API': título, ajuda de uma linha, campo e Continuar desabilitado sem link", () => {
  const html = link()
  assert.match(html, /Link da API/)
  assert.match(html, /Cole o link da documentação ou do arquivo OpenAPI\./)
  assert.match(html, /type="url"/)
  assert.match(html, /disabled=""[^>]*>Continuar/)
  assert.doesNotMatch(html, /role="alert"/)
  assert.doesNotMatch(html, /Atlas|agente sugeriu|bot sugeriu/i)
  assert.doesNotMatch(link({ value: "https://exemplo.test/openapi.json" }), /disabled=""[^>]*>Continuar/)
})

test("passo 'Link da API': erro em português simples e estado ocupado", () => {
  const message = "Não encontrei a especificação da API nesse link. Tente o link do arquivo OpenAPI (.json ou .yaml)."
  const html = link({ value: "https://exemplo.test", error: message })
  assert.match(html, /role="alert"/)
  assert.ok(html.includes(message))
  assert.match(link({ value: "https://exemplo.test", busy: true }), />Lendo…</)
})

test("depois do link: a mesma folha de passos do card (Credenciais, depois Acesso)", () => {
  const html = renderToStaticMarkup(<ApiConnectFlow busy={false} onOpenChange={noop} onSubmit={noop} proposal={proposal} />)
  assert.match(html, /1 de 2/)
  assert.match(html, /Credenciais/)
  assert.match(html, /Chave/)
  const access = renderToStaticMarkup(<ApiConnectFlow busy={false} initial={{ step: 2, apiKey: "k" }} onOpenChange={noop} onSubmit={noop} proposal={proposal} />)
  assert.match(access, /Tudo em modo leitura/)
  assert.match(access, />Conectar</)
})

test("cópia: o formulário MCP não diz que o agente sugeriu; o usuário está conectando", () => {
  const html = renderToStaticMarkup(
    <CustomConnectorForm busy={false} initial={{ name: "Linear", url: "https://mcp.linear.test/mcp", auth: "oauth" }} onBack={noop} onConnected={noop} onOAuth={noop} />,
  )
  assert.match(html, /Conectar <span[^>]*>Linear<\/span>/)
  assert.doesNotMatch(html, /sugeriu|a pedido/i)
  const blank = renderToStaticMarkup(<CustomConnectorForm busy={false} initial={{ name: "", url: "", auth: "oauth" }} onBack={noop} onConnected={noop} onOAuth={noop} />)
  assert.doesNotMatch(blank, /Confira os dados/)
})
