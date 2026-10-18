import assert from "node:assert/strict"
import test from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ComposioStatusView } from "@workspace/shared"
import { ComposioAppsView, type ComposioAppsViewProps } from "./composio-apps"
import {
  composioLogoUrl,
  ComposioAppIcon,
} from "@/components/ai-elements/connectors/composio-app-icon"
import {
  COMPOSIO_FIRST_PAGE,
  composioNextPage,
} from "@/components/settings/composio-state"
import { shouldLoadComposioApps } from "@/hooks/use-composio"
Object.assign(globalThis, { React })
const noop = () => {}
const on: ComposioStatusView = {
  configured: true,
  keyHint: "••••9999",
  secretBoxReady: true,
  toolCount: 0,
}
const off: ComposioStatusView = { ...on, configured: false, keyHint: null }
const linear = {
  slug: "linear",
  name: "Linear",
  description: "Issues",
  logo: "https://logos.example/linear.svg",
  connected: false,
  noAuth: false,
  nativeCatalogId: null,
}
function view(props: Partial<ComposioAppsViewProps> = {}) {
  return renderToStaticMarkup(
    <ComposioAppsView
      status={on}
      loading={false}
      toolkits={[linear]}
      connections={[]}
      error={null}
      busy={null}
      nativeConnections={[]}
      categories={[]}
      category=""
      pager={COMPOSIO_FIRST_PAGE}
      hasNext={false}
      totalItems={null}
      onCategory={noop}
      onPrev={noop}
      onNext={noop}
      onSaveKey={noop}
      onConnect={noop}
      onDisconnect={noop}
      onManageKey={noop}
      {...props}
    />
  )
}
test("com chave: página de apps com logo, conectar e paginador", () => {
  const html = view({
    pager: composioNextPage(COMPOSIO_FIRST_PAGE, "c2"),
    hasNext: true,
    totalItems: 100,
  })
  assert.match(html, /Apps do Composio/)
  assert.match(html, /src="https:\/\/logos.example\/linear.svg"/)
  assert.match(html, /aria-label="Conectar Linear"/)
  assert.match(html, /referrerPolicy="no-referrer"/)
  assert.match(html, /aria-label="Paginação do catálogo do Composio"/)
  assert.match(html, /Anterior/)
  assert.match(html, /Próxima/)
  assert.match(html, /Página 2 de 5/)
  assert.match(html, /100 apps/)
  assert.match(html, /Chave salva \(••••9999\)/)
})

test("sem próxima página nem anterior não mostra paginador; na primeira, Anterior fica desabilitado", () => {
  assert.doesNotMatch(view(), /Paginação do catálogo/)
  const first = view({ hasNext: true })
  assert.match(first, /Próxima/)
  assert.match(first, /<button[^>]*disabled=""[^>]*>(<svg[^>]*>.*?<\/svg>)?Anterior/)
})

test("sem chave: formulário inline, link para composio.dev e nota de opcional", () => {
  const html = view({ status: off, toolkits: [] })
  assert.match(html, /type="password"/)
  assert.match(html, /autoComplete="off"/)
  assert.match(html, /Salvar/)
  assert.match(html, /Opcional/)
  assert.match(html, /href="https:\/\/composio.dev"/)
  assert.match(html, /rel="noopener noreferrer"/)
  assert.doesNotMatch(html, /Conectar Linear/)
  assert.doesNotMatch(html, /Paginação do catálogo/)
})

test("sem chave e cofre indisponível: avisa e desabilita o salvamento", () => {
  const html = view({ status: { ...off, secretBoxReady: false }, toolkits: [] })
  assert.match(html, /CONNECTOR_ENCRYPTION_KEY/)
  assert.match(html, /disabled/)
})

test("conectado pelo Composio mostra Desconectar com a conta; sem login mostra Desativar", () => {
  const html = view({
    toolkits: [
      { ...linear, connected: true },
      { ...linear, slug: "exa", name: "Exa", noAuth: true, connected: true },
    ],
    connections: [
      { id: "ca_1", toolkit: "linear" },
      { id: "noauth_exa", toolkit: "exa" },
    ],
  })
  assert.match(html, /aria-label="Desconectar Linear"/)
  assert.match(html, /aria-label="Desativar Exa"/)
  assert.match(html, /Conectado pelo Composio/)
  assert.match(html, /Ativado pelo Composio/)
  assert.doesNotMatch(html, /aria-label="Conectar Linear"/)
})

test("conector nativo equivalente conectado: selo Já conectado nativamente, sem botão de conectar", () => {
  const html = view({
    toolkits: [{ ...linear, nativeCatalogId: "github" }],
    nativeConnections: [{ catalogId: "github", status: "connected" }],
  })
  assert.match(html, /Já conectado nativamente/)
  assert.doesNotMatch(html, /aria-label="Conectar Linear"/)
  const pending = view({
    toolkits: [{ ...linear, nativeCatalogId: "github" }],
    nativeConnections: [{ catalogId: "github", status: "pending_auth" }],
  })
  assert.doesNotMatch(pending, /Já conectado nativamente/)
  assert.match(pending, /aria-label="Conectar Linear"/)
})

test("carregamento, vazio e erro são explícitos", () => {
  assert.match(view({ status: null }), /Carregando apps/)
  assert.match(view({ loading: true, toolkits: [] }), /Carregando apps/)
  assert.doesNotMatch(
    view({ loading: true, toolkits: [] }),
    /Nenhum app encontrado/
  )
  assert.match(view({ toolkits: [] }), /Nenhum app encontrado/)
  assert.match(
    view({ error: "Falha ao carregar", toolkits: [] }),
    /role="alert"/
  )
  assert.match(view({ status: null, error: "Falha" }), /role="alert"/)
  assert.match(view({ busy: "linear" }), /disabled/)
})

test("filtro de categoria só aparece quando a API devolve categorias", () => {
  assert.doesNotMatch(view(), /Filtrar por categoria/)
  const html = view({
    categories: [{ id: "crm", name: "CRM" }],
    category: "crm",
  })
  assert.match(html, /aria-label="Filtrar por categoria"/)
})

test("logo rejeita protocolo não https e credenciais; nulo tem fallback", () => {
  for (const url of [
    null,
    "http://example.com/a.svg",
    "javascript:alert(1)",
    "https://user:secret@example.com/a.svg",
    "//example.com/a.svg",
  ])
    assert.equal(composioLogoUrl(url), null)
  assert.equal(
    composioLogoUrl("https://example.com/a.svg"),
    "https://example.com/a.svg"
  )
  assert.doesNotMatch(
    renderToStaticMarkup(<ComposioAppIcon logo="javascript:alert(1)" />),
    /<img/
  )
})
test("catálogo não carrega sem chave ou com dialog fechado", () => {
  assert.equal(shouldLoadComposioApps(false, true), false)
  assert.equal(shouldLoadComposioApps(true, false), false)
  assert.equal(shouldLoadComposioApps(true, true), true)
})

test("app sem login mostra o selo Sem login e Ativar em vez de Conectar", () => {
  const html = view({
    toolkits: [{ ...linear, slug: "exa", name: "Exa", noAuth: true }],
  })
  assert.match(html, /Sem login/)
  assert.match(html, /aria-label="Ativar Exa"/)
  assert.doesNotMatch(html, /Conectar Exa/)
  assert.doesNotMatch(view(), /Sem login/)
})
