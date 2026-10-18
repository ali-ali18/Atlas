import React from "react"
Object.assign(globalThis, { React })
import assert from "node:assert/strict"
import { test } from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ApiConnectionView, ApiProposal, McpConnectionView } from "@workspace/shared"
import { ApiConnectFlow } from "@/components/ai-elements/login/api-connect-sheet"
import { ANOTHER_ACCOUNT_HINT, accountCountText, accountDisplayLabel, groupAccounts, primaryAccount } from "@/lib/connector-accounts"
import { ApiConnectionCard } from "./api-connections-section"
import { ApiConnectionPage } from "./api-connection-page"
import { AccountsSection } from "./connector-accounts"
import { ConnectorPage, mcpAccountRows } from "./connector-page"
import type { McpCatalogItem } from "@/lib/atlas-api"

const noop = () => undefined

const mcp = (over: Partial<McpConnectionView> = {}): McpConnectionView => ({
  id: "m1",
  catalogId: "notion",
  slug: "notion",
  name: "Notion",
  url: "https://mcp.notion.com/mcp",
  authType: "oauth",
  status: "connected",
  tools: [],
  disabledTools: [],
  confirmWrites: true,
  lastError: null,
  accountLabel: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
})

const api = (over: Partial<ApiConnectionView> = {}): ApiConnectionView => ({
  id: "a1",
  slug: "bling",
  name: "Bling",
  domain: "api.bling.com.br",
  baseUrl: "https://api.bling.com.br/Api/v3",
  authKind: "oauth2",
  status: "connected",
  lastError: null,
  groups: [{ tag: "Pedidos", total: 3, read: 2, write: 1 }],
  allowedTags: ["Pedidos"],
  operationCount: 3,
  rateLimitRps: 3,
  accountLabel: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
})

const entry = {
  id: "notion",
  name: "Notion",
  description: "Páginas e bancos de dados.",
  longDescription: "Leia e escreva no Notion.",
  category: "productivity",
  icon: "/connectors/notion.svg",
  developer: "Notion",
  website: "notion.so",
  sourceUrl: "https://notion.so",
  skills: [],
  authType: "oauth",
  availability: "available",
  docsUrl: "",
  oauthReady: true,
  oauthMissingEnv: [],
  connectionId: null,
  status: null,
} as unknown as McpCatalogItem

test("apelido exibido: o digitado; sem apelido e com várias contas, 'Conta N' pela ordem; conta única sem apelido não mostra nada", () => {
  const a = mcp({ id: "a", accountLabel: "Notion pessoal" })
  const b = mcp({ id: "b" })
  assert.equal(accountDisplayLabel(a, [a, b]), "Notion pessoal")
  assert.equal(accountDisplayLabel(b, [a, b]), "Conta 2")
  assert.equal(accountDisplayLabel(a, [a]), "Notion pessoal")
  assert.equal(accountDisplayLabel(mcp(), [mcp()]), null)
  assert.equal(accountDisplayLabel(mcp({ accountLabel: "  " }), [mcp()]), null)
})

test("cartão do catálogo representa a conta conectada (senão a primeira)", () => {
  const pending = mcp({ id: "p", status: "pending_auth" })
  const ok = mcp({ id: "o" })
  assert.equal(primaryAccount([pending, ok])?.id, "o")
  assert.equal(primaryAccount([pending])?.id, "p")
  assert.equal(primaryAccount([]), undefined)
})

test("seção Contas: uma linha por conta, contador, botão 'Adicionar outra conta' e o aviso de sair da conta atual", () => {
  const html = renderToStaticMarkup(
    <AccountsSection
      accounts={mcpAccountRows([mcp({ id: "a", accountLabel: "Notion pessoal" }), mcp({ id: "b", status: "pending_auth" })], "Notion", "a")}
      oauthHint
      onAdd={noop}
      onDisconnect={noop}
      onReconnect={noop}
      onRename={noop}
      onSelect={noop}
    />,
  )
  assert.match(html, /aria-label="Contas"/)
  assert.match(html, /Contas <span[^>]*>2<\/span>/)
  assert.match(html, />Notion pessoal</)
  assert.match(html, />Conta 2</)
  assert.match(html, /Adicionar outra conta/)
  assert.match(html, /aria-label="Renomear Notion pessoal"/)
  assert.match(html, /aria-label="Desconectar Conta 2"/)
  assert.match(html, /Reconectar/)
  assert.match(html, /aria-current="true"/)
  assert.ok(html.includes(ANOTHER_ACCOUNT_HINT))
  assert.doesNotMatch(html, /Atlas/)
})

test("seção Contas sem login por navegador não mostra o aviso; ocupado troca o rótulo do botão", () => {
  const html = renderToStaticMarkup(
    <AccountsSection accounts={mcpAccountRows([mcp()], "Notion")} adding onAdd={noop} onDisconnect={noop} onRename={noop} />,
  )
  assert.ok(!html.includes(ANOTHER_ACCOUNT_HINT))
  assert.match(html, /Conectando…/)
  assert.match(html, />Notion</)
})

test("página do conector com 2 contas: seção Contas, configuração da conta aberta e sem 'Desconectar' duplicado", () => {
  const accounts = [mcp({ id: "a", accountLabel: "Notion pessoal" }), mcp({ id: "b", slug: "notion-2", accountLabel: "Notion trabalho" })]
  const html = renderToStaticMarkup(
    <ConnectorPage
      accounts={accounts}
      connection={accounts[1]}
      entry={entry}
      icon={<span />}
      onAction={noop}
      onAddAccount={noop}
      onChanged={noop}
      onDeleted={noop}
      onDisconnectAccount={noop}
      onRenameAccount={noop}
      onSelectAccount={noop}
      secretBoxReady
      busy={false}
    />,
  )
  assert.match(html, /aria-label="Contas"/)
  assert.match(html, /aria-label="Conta em configuração"/)
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>(<span[^>]*>)?Notion trabalho/)
  assert.doesNotMatch(html, /notion-2/)
  assert.match(html, />Notion pessoal<[^]*>0 ferramentas</)
  assert.match(html, /Aplicativos 2/)
  assert.match(html, /2 aplicativos, 0 habilidades/)
  // O único "Desconectar" visível é o de cada conta (aria-label por conta); não há botão geral embaixo.
  assert.equal((html.match(/>Desconectar</g) ?? []).length, 2)
})

test("página do conector sem contas (ainda não conectado) não mostra a seção", () => {
  const html = renderToStaticMarkup(
    <ConnectorPage entry={entry} icon={<span />} onAction={noop} onChanged={noop} onDeleted={noop} secretBoxReady busy={false} />,
  )
  assert.doesNotMatch(html, /aria-label="Contas"/)
})

test("cartão de API conectado mostra o apelido da conta como subtítulo (e o endereço)", () => {
  const html = renderToStaticMarkup(<ApiConnectionCard accountLabel="Bling loja" item={api()} onOpen={noop} />)
  assert.match(html, /Bling loja · <span[^>]*>api\.bling\.com\.br<\/span>/)
  assert.match(html, /aria-label="Ver detalhes de Bling — Bling loja"/)
  const plain = renderToStaticMarkup(<ApiConnectionCard item={api()} onOpen={noop} />)
  assert.match(plain, /API · <span/)
})

test("página da API com 2 contas: Contas com as duas, a aberta destacada, renomear e desconectar por conta", () => {
  const accounts = [api({ id: "a1", accountLabel: "Bling loja" }), api({ id: "a2", slug: "bling-2", accountLabel: "Bling atacado" })]
  const html = renderToStaticMarkup(
    <ApiConnectionPage
      accounts={{ items: accounts, onAdd: noop, onOpen: noop, onRemove: noop, onRename: noop }}
      busy={false}
      item={accounts[1]!}
      loadOperations={async () => []}
      onReconnect={noop}
      onRemove={noop}
      onSaveGroups={noop}
    />,
  )
  assert.match(html, /Contas <span[^>]*>2<\/span>/)
  assert.match(html, /Adicionar outra conta/)
  assert.match(html, /aria-label="Renomear Bling loja"/)
  assert.match(html, /aria-label="Desconectar Bling atacado"/)
  assert.match(html, /Bling atacado · <span/)
  assert.ok(html.includes(ANOTHER_ACCOUNT_HINT))
  assert.match(html, /aria-current="true"/)
})

const proposal: ApiProposal = {
  specUrl: "https://developer.exemplo.test/openapi.json",
  name: "Exemplo API",
  domain: "api.exemplo.test",
  baseUrl: "https://api.exemplo.test/v3",
  authKind: "oauth2",
  operationCount: 3,
  readCount: 2,
  groups: [{ tag: "Pedidos", total: 3, read: 2, write: 1 }],
}

test("fluxo de outra conta por OAuth avisa para sair da conta atual (só no passo de autorizar)", () => {
  const authorize = renderToStaticMarkup(
    <ApiConnectFlow anotherAccount busy={false} initial={{ step: 2, clientId: "a", clientSecret: "b" }} onOpenChange={noop} onSubmit={noop} proposal={proposal} />,
  )
  assert.ok(authorize.includes(ANOTHER_ACCOUNT_HINT))
  const credentials = renderToStaticMarkup(<ApiConnectFlow anotherAccount busy={false} onOpenChange={noop} onSubmit={noop} proposal={proposal} />)
  assert.ok(!credentials.includes(ANOTHER_ACCOUNT_HINT))
  const first = renderToStaticMarkup(
    <ApiConnectFlow busy={false} initial={{ step: 2, clientId: "a", clientSecret: "b" }} onOpenChange={noop} onSubmit={noop} proposal={proposal} />,
  )
  assert.ok(!first.includes(ANOTHER_ACCOUNT_HINT))
})

test("um cartão por serviço: contas agrupadas por catálogo/base, na ordem da primeira ocorrência", () => {
  const items = [mcp({ id: "1" }), mcp({ id: "2", catalogId: "slack" }), mcp({ id: "3" }), mcp({ id: "4", catalogId: null })]
  const groups = groupAccounts(items, (item) => item.catalogId ?? `c.${item.id}`)
  assert.deepEqual(groups.map((group) => group.map((item) => item.id)), [["1", "3"], ["2"], ["4"]])
  assert.equal(accountCountText(2), "2 contas")
})

test("cartão de API com 2 contas mostra '2 contas' e o nome do serviço", () => {
  const two = renderToStaticMarkup(<ApiConnectionCard accountCount={2} accountLabel="Bling loja" item={api()} onOpen={noop} />)
  assert.match(two, /2 contas · <span/)
  assert.match(two, /aria-label="Ver detalhes de Bling"/)
  assert.doesNotMatch(two, /Bling loja/)
})

test("página do conector com uma conta: Aplicativos 1 e 1 aplicativo", () => {
  const html = renderToStaticMarkup(
    <ConnectorPage accounts={[mcp()]} connection={mcp()} entry={entry} icon={<span />} onAction={noop} onAddAccount={noop} onChanged={noop} onDeleted={noop} onDisconnectAccount={noop} onRenameAccount={noop} secretBoxReady busy={false} />,
  )
  assert.match(html, /Aplicativos 1/)
  assert.match(html, /1 aplicativo, 0 habilidades/)
})
