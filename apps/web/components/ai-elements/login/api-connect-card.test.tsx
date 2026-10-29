import React from "react"
Object.assign(globalThis, { React })
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { parseOpenApiDocument, summarizeApiGroups, type ApiConnectionView, type ApiProposal, type LoginConnector } from "@workspace/shared"
import { apiAccessSummary, apiConnectionStatusLabel, ApiConnectionCard } from "@/components/ui/templates/template-4/marketplace/api-connections-section"
import { ApiConnectionPage } from "@/components/ui/templates/template-4/marketplace/api-connection-page"
import { ApiConnectCardView } from "./api-connect-card"
import { ApiConnectFlow, apiDisplayName, RedirectUrlPill, apiConnectReady, credentialsReady, groupListText, needsCredentials } from "./api-connect-sheet"

const bling: ApiProposal = {
  specUrl: "https://developer.bling.test/openapi.json",
  name: "Bling API",
  domain: "api.bling.test",
  baseUrl: "https://api.bling.test/Api/v3",
  authKind: "oauth2",
  operationCount: 6,
  readCount: 4,
  groups: [
    { tag: "Contatos", total: 1, read: 1, write: 0 },
    { tag: "Pedidos - Vendas", total: 4, read: 2, write: 2 },
    { tag: "Produtos", total: 1, read: 1, write: 0 },
  ],
  redirectUrl: "https://app.example.test/v1/mcp/oauth/callback",
}
const connector = (api: ApiProposal, extra: Partial<LoginConnector> = {}): LoginConnector => ({
  kind: "api",
  id: "bling-api",
  name: api.name,
  description: "",
  icon: null,
  api,
  ...extra,
})
const view = (
  api: ApiProposal,
  options: { connected?: boolean; status?: "pending" | "done"; dismissed?: boolean; detailsOpen?: boolean; canResume?: boolean } = {}
) =>
  renderToStaticMarkup(
    <ApiConnectCardView
      canResume={options.canResume}
      connected={options.connected ?? false}
      connector={connector(api)}
      detailsOpen={options.detailsOpen}
      dismissed={options.dismissed}
      onConnect={() => undefined}
      onDismiss={() => undefined}
      onDone={() => undefined}
      onManage={() => undefined}
      status={options.status}
    />
  )

test("card compacto: título, chip Só leitura, uma frase e dois botões, nada mais", () => {
  const html = view(bling)
  assert.match(html, /Conectar Bling</)
  assert.match(html, /Só leitura/)
  assert.match(html, /O bot vai poder consultar pedidos de vendas, produtos e contatos\. Não pode criar, alterar nem excluir nada\./)
  assert.match(html, />Conectar<\/button>/)
  assert.match(html, />Agora não<\/button>/)
  assert.match(html, />Detalhes<\/button>/)
  for (const hidden of [/>api\.bling\.test</, /OAuth2/, /Client ID/, /Client secret/, /redirecionamento/, /Escrita/, /operações/, /type="password"/])
    assert.doesNotMatch(html, hidden)
  assert.doesNotMatch(html, /Atlas/)
})

test("Detalhes revela site, acesso e contagens em palavras simples", () => {
  const html = view(bling, { detailsOpen: true })
  assert.match(html, /api\.bling\.test/)
  assert.match(html, /OAuth2 \(código de autorização\)/)
  assert.match(html, /6 ações · 4 só para ler/)
  for (const jargon of [/>Domínio</, />Autenticação</, />Operações</]) assert.doesNotMatch(html, jargon)
  assert.doesNotMatch(html, /outro domínio/)
  assert.match(view({ ...bling, crossHost: true }, { detailsOpen: true }), /outro domínio/)
})

test("conectada: uma linha com Gerenciar; Retomar só se o run espera; dispensada recolhe", () => {
  const html = view(bling, { connected: true })
  assert.match(html, /Bling conectado · só leitura/)
  assert.match(html, />Gerenciar</)
  assert.doesNotMatch(html, />Retomar</)
  assert.doesNotMatch(html, /Client secret|>Conectar</)
  assert.match(view(bling, { connected: true, canResume: true }), />Retomar</)
  assert.doesNotMatch(view(bling, { status: "done", canResume: true }), />Retomar</)
  assert.match(view(bling, { dismissed: true }), /Dispensado/)
})

test("frase dos grupos: até 3 com mais consultas e 'e mais N'", () => {
  assert.equal(groupListText(bling, 3), "pedidos de vendas, produtos e contatos")
  assert.equal(apiDisplayName("Bling API"), "Bling")
  assert.equal(apiDisplayName("API"), "API")
  assert.equal(
    groupListText({ ...bling, groups: [...bling.groups, { tag: "Estoques", total: 2, read: 2, write: 0 }, { tag: "Nota Fiscal", total: 3, read: 3, write: 0 }] }, 3),
    "pedidos de vendas, produtos, estoques e mais 2"
  )
})

test("prontidão por tipo de autenticação e passos", () => {
  const empty = { clientId: "", clientSecret: "", apiKey: "", allowedTags: ["Produtos"] }
  assert.equal(credentialsReady(bling, empty), false)
  assert.equal(credentialsReady(bling, { ...empty, clientId: "id", clientSecret: "s" }), true)
  assert.equal(apiConnectReady(bling, { ...empty, clientId: "id", clientSecret: "s", allowedTags: [] }), false)
  assert.equal(credentialsReady({ ...bling, authKind: "bearer" }, { ...empty, apiKey: "t" }), true)
  assert.equal(needsCredentials({ ...bling, authKind: "none" }), false)
  assert.equal(apiConnectReady({ ...bling, authKind: "none" }, empty), true)
})

test("URL de redirecionamento só quebra nos separadores", () => {
  const html = renderToStaticMarkup(<RedirectUrlPill url={bling.redirectUrl!} />)
  assert.match(html, /mcp\/<wbr\/>oauth\/<wbr\/>callback/)
  assert.match(html, /word-break:normal/)
  assert.match(html, /overflow-wrap:normal/)
})

const sheet = (api: ApiProposal, initial: Parameters<typeof ApiConnectFlow>[0]["initial"] = {}) =>
  renderToStaticMarkup(<ApiConnectFlow busy={false} initial={initial} onOpenChange={() => undefined} onSubmit={() => undefined} proposal={api} />)

test("folha, passo 1: só as credenciais, 'Onde encontro isso?' recolhido, Continuar desabilitado", () => {
  const html = sheet(bling)
  assert.ok(html.length > 0, "a folha deve renderizar")
  assert.match(html, /1 de 2/)
  assert.match(html, /Client ID/)
  assert.match(html, /type="password"/)
  assert.match(html, /Onde encontro isso\?/)
  assert.match(html, /callback/)
  assert.match(html, /Cadastre este endereço no app da API antes de continuar\./)
  assert.match(html, /disabled=""[^>]*>Continuar/)
  assert.match(sheet(bling, { helpOpen: true }), /crie um aplicativo e copie o Client ID/)
  assert.doesNotMatch(sheet({ ...bling, authKind: "apiKey" }), /Cadastre este endereço/)
})

test("folha, passo 2: leitura por padrão, Personalizar e botão de autorizar; sem linha de escrita", () => {
  const html = sheet(bling, { step: 2, clientId: "i", clientSecret: "s" })
  assert.ok(html.length > 0)
  assert.match(html, /2 de 2/)
  assert.match(html, /Tudo em modo leitura: pedidos de vendas, produtos e contatos\./)
  assert.match(html, /Autorizar no Bling</)
  assert.match(html, /Ações de escrita chegam em breve\./)
  assert.doesNotMatch(html, /Escrita \(criar/)
})

const item: ApiConnectionView = {
  id: "api-1",
  slug: "bling-api",
  name: "Bling API",
  domain: "api.bling.test",
  baseUrl: "https://api.bling.test/Api/v3",
  authKind: "oauth2",
  status: "connected",
  lastError: null,
  groups: bling.groups,
  allowedTags: ["Produtos", "Contatos"],
  operationCount: 6,
  rateLimitRps: 3,
  accountLabel: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}
const card = (over: Partial<ApiConnectionView> = {}) =>
  renderToStaticMarkup(<ApiConnectionCard item={{ ...item, ...over }} onOpen={() => undefined} />)
const page = (over: Partial<ApiConnectionView> = {}, extra: { busy?: boolean; error?: string | null } = {}) =>
  renderToStaticMarkup(
    <ApiConnectionPage busy={extra.busy ?? false} error={extra.error} item={{ ...item, ...over }} onReconnect={() => undefined} onRemove={() => undefined} onSaveGroups={() => undefined} />
  )

test("cartão da lista: nome, API e domínio, abre a página; Reconectar só se não conectada", () => {
  const connected = card()
  assert.match(connected, /Ver detalhes de Bling API/)
  assert.match(connected, /API · <span[^>]*>api\.bling\.test<\/span>/)
  assert.match(connected, /Conectada/)
  assert.doesNotMatch(connected, /Reconectar/)
  assert.doesNotMatch(connected, /Liberar/)
  const expired = card({ status: "pending_auth", lastError: "O login expirou ou foi revogado" })
  assert.match(expired, />Reconectar</)
  assert.match(expired, /Login pendente: O login expirou ou foi revogado/)
})

test("página da API: resumo, ações e grupos em linhas com toggle", () => {
  const html = page()
  assert.match(html, /<h2[^>]*>Bling API<\/h2>/)
  assert.match(html, /https:\/\/api\.bling\.test\/Api\/v3/)
  assert.match(html, /Leitura · 2 de 3 grupos/)
  assert.match(html, />Desconectar</)
  assert.doesNotMatch(html, />Reconectar</)
  assert.match(html, />Liberar todos</)
  assert.match(html, />Nenhum</)
  assert.match(html, /aria-label="Buscar grupo"/)
  assert.match(html, /aria-labelledby="api-group-api-1-Contatos-nome"/)
  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /2 consultas/)
  assert.match(html, /1 consulta</)
  assert.equal((html.match(/role="switch"/g) ?? []).length, 3)
})

test("página da API: sessão expirada mostra Reconectar; salvando e erro aparecem", () => {
  const html = page({ status: "pending_auth", lastError: "O login expirou" }, { busy: true, error: "Falhou ao salvar" })
  assert.match(html, /Conectando…/)
  assert.match(html, /Salvando…/)
  assert.match(html, /role="alert"[^>]*>Falhou ao salvar/)
  assert.match(page({ status: "pending_auth" }), />Reconectar</)
})

test("resumos de estado e acesso", () => {
  assert.equal(apiConnectionStatusLabel({ status: "error", lastError: null }), "Erro")
  assert.equal(apiAccessSummary({ groups: bling.groups, allowedTags: ["Produtos"] }), "Leitura · 1 de 3 grupos")
})

test("link encontrado pelo bot: linha neutra com o domínio; link do usuário não mostra", () => {
  const html = view({ ...bling, foundByBot: true })
  assert.match(html, /Link encontrado pelo bot · <span[^>]*>developer\.bling\.test<\/span>/)
  assert.doesNotMatch(html, /sugeriu/)
  assert.doesNotMatch(view(bling), /Link encontrado pelo bot/)
  assert.doesNotMatch(view({ ...bling, foundByBot: true }, { dismissed: true }), /Link encontrado pelo bot/)
})

test("frase dos grupos com a especificação real do Bling (recorte): pedidos, produtos, estoques", () => {
  const raw = JSON.parse(readFileSync(new URL("../../../../../packages/shared/src/fixtures/bling-openapi.trimmed.json", import.meta.url), "utf8"))
  const parsed = parseOpenApiDocument(raw, { specUrl: "https://developer.bling.com.br/o.json" })
  if (!parsed.ok) throw new Error(parsed.error)
  const proposal: ApiProposal = { ...bling, groups: summarizeApiGroups(parsed.spec.operations) }
  const text = groupListText(proposal, 3)
  assert.match(text, /^pedidos de vendas, produtos, /)
  assert.doesNotMatch(text, /lotes|campos customizados/)
})
