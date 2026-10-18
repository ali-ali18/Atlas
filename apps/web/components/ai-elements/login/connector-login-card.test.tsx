import React from "react"
Object.assign(globalThis, { React })
import assert from "node:assert/strict"
import { test } from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { LoginConnector } from "@workspace/shared"
import type { McpCatalogItem } from "@/lib/atlas-api"
import { nativeConnectorAction } from "@/hooks/use-native-connector"
import {
  ConnectorLoginCardView,
  legacyComposioConnector,
  type ConnectorCardAction,
} from "./connector-login-card"

const composio: LoginConnector = {
  kind: "composio",
  id: "linear",
  name: "Linear",
  description: "Issues e projetos",
  icon: "https://logos.composio.dev/linear.png",
}
const github: LoginConnector = {
  kind: "native",
  id: "github",
  name: "GitHub",
  description: "Repositórios, issues e pull requests.",
  icon: "/connectors/github.svg",
}
const view = (
  connector: LoginConnector,
  options: {
    connected?: boolean
    action?: ConnectorCardAction
    status?: "pending" | "done"
    busy?: boolean
    dismissed?: boolean
  } = {}
) =>
  renderToStaticMarkup(
    <ConnectorLoginCardView
      connector={connector}
      status={options.status}
      action={options.action ?? "connect"}
      connected={options.connected ?? false}
      busy={options.busy ?? false}
      onAction={() => undefined}
      onDismiss={connector.kind === "custom" ? () => undefined : undefined}
      dismissed={options.dismissed}
    />
  )

test("card nativo mostra ícone, nome, descrição e o botão Conectar", () => {
  const html = view(github)
  assert.match(html, /src="\/connectors\/github\.svg"/)
  assert.match(html, /Conectar GitHub/)
  assert.match(html, /Repositórios, issues e pull requests\./)
  assert.match(html, />Conectar<\/button>/)
  assert.doesNotMatch(html, /Abrir a VM/)
  assert.match(html, /disabled=""[^>]*>Retomar tarefa/)
})

test("conector desconectado mostra Reconectar", () => {
  const html = view({ ...github, reconnect: true })
  assert.match(html, /Reconectar GitHub/)
  assert.match(html, />Reconectar<\/button>/)
})

test("app do Composio mostra o logo real, nome e descrição do toolkit", () => {
  const html = view(composio)
  assert.match(html, /src="https:\/\/logos\.composio\.dev\/linear\.png"/)
  assert.match(html, /referrerPolicy="no-referrer"/)
  assert.match(html, /Conectar Linear/)
  assert.match(html, /Issues e projetos/)
})

test("sem chave do Composio o card oferece configurar; sem login de um clique abre o Marketplace", () => {
  assert.match(view(composio, { action: "configure" }), /Configurar Composio/)
  assert.match(view(github, { action: "marketplace" }), /Informar chave no Marketplace/)
  assert.doesNotMatch(view(github, { action: "connect" }), /Marketplace/)
})

test("OAuth sempre conecta direto do card; só chave de API manda ao Marketplace", () => {
  const entry = (extra: Record<string, unknown>) => extra as unknown as McpCatalogItem
  assert.equal(nativeConnectorAction(null), "loading")
  assert.equal(nativeConnectorAction(entry({ authType: "oauth", oauthReady: true })), "connect")
  assert.equal(nativeConnectorAction(entry({ authType: "oauth", oauthReady: false })), "connect")
  assert.equal(nativeConnectorAction(entry({ authType: "oauth", oauthReady: false, apiKey: {} })), "marketplace")
  assert.equal(nativeConnectorAction(entry({ authType: "api_key" })), "marketplace")
})

test("ícone inválido cai no ícone padrão e card antigo sem dados continua abrindo", () => {
  const html = view({ ...composio, icon: "javascript:alert(1)" })
  assert.doesNotMatch(html, /javascript:/)
  assert.doesNotMatch(html, /<img/)
  assert.match(view(legacyComposioConnector("linear")), /Conectar linear/)
})

test("retomada só libera após a conexão; concluído não mostra botões", () => {
  assert.doesNotMatch(view(github, { connected: true }), /disabled=""[^>]*>Retomar tarefa/)
  const done = view(github, { status: "done" })
  assert.match(done, /GitHub conectado/)
  assert.doesNotMatch(done, /<button/)
})

test("app do Composio sem login: o card pede Ativar, sem falar de conexão", () => {
  const html = view({
    kind: "composio",
    id: "exa",
    name: "Exa",
    description: "",
    icon: null,
    noAuth: true,
  })
  assert.match(html, /Ativar Exa/)
  assert.match(html, />Ativar<\/button>/)
  assert.match(html, /não precisa de login/)
  assert.doesNotMatch(html, />Conectar<\/button>/)
})

const custom: LoginConnector = {
  kind: "custom",
  id: "mcp-acme-example",
  name: "Acme",
  description: "Ler pedidos do ERP",
  icon: "/v1/mcp/icon/mcp.acme.example",
  url: "https://mcp.acme.example/mcp",
  auth: "oauth",
}

test("card de MCP personalizado: logo via API, URL, Conectar e Agora não", () => {
  const html = view(custom)
  assert.match(html, /Conectar Acme/)
  assert.match(html, /src="\/v1\/mcp\/icon\/mcp\.acme\.example"/)
  assert.match(html, /https:\/\/mcp\.acme\.example\/mcp/)
  assert.match(html, />Conectar<\/button>/)
  assert.match(html, />Agora não<\/button>/)
  assert.match(html, /Ler pedidos do ERP/)
})

test("MCP personalizado conectado libera Retomar tarefa; dispensado fica resolvido", () => {
  assert.match(view(custom, { connected: true }), />Retomar tarefa<\/button>/)
  assert.doesNotMatch(view(custom, { connected: true }), /Agora não/)
  const dismissed = view(custom, { dismissed: true })
  assert.match(dismissed, /Acme não conectado/)
  assert.doesNotMatch(dismissed, />Conectar<\/button>/)
})
