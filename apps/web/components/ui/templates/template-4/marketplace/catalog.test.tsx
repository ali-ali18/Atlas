import assert from "node:assert/strict"
import test from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  AtlasApiError,
  catalogEditedConflict,
  type CatalogBotDetail,
  type CatalogSkillDetail,
  type CatalogSkillItem,
} from "@/lib/atlas-api"
import { loadMessages } from "@/lib/i18n/messages"
import { createTranslator } from "@/lib/i18n/translator"
import { createZip, crc32 } from "@/lib/zip"
import { MARKETPLACE_SECTIONS } from "@/lib/marketplace-url"
import {
  BotInstallFlow,
  PublishFlow,
  SkillConflictFlow,
  SkillInstallFlow,
} from "./catalog-panels"
import {
  categoriesOf,
  categoryLabel,
  diffLabel,
  filterCatalogItems,
  installSummary,
  parseTagInput,
  scopeOptions,
  suggestVersion,
} from "./catalog-state"
import { BotPageView, BotsListView, SkillPageView, SkillsListView } from "./catalog-views"
import { MarketplaceSections } from "./marketplace-sections"

Object.assign(globalThis, { React })
const noop = () => {}
const SHA = "a".repeat(64)

const install = (over: Partial<CatalogSkillItem["installs"][number]> = {}) => ({
  id: "d1",
  botId: null,
  name: "roblox",
  version: "1.0.0",
  edited: false,
  updateAvailable: false,
  ...over,
})

const roblox: CatalogSkillItem = {
  slug: "roblox",
  name: "Roblox (Luau + Rojo)",
  description: "Desenvolve jogos Roblox em Luau com Rojo.",
  version: "1.0.0",
  author: "ali-ali18",
  category: "games",
  tags: ["roblox", "luau"],
  tools: ["shell", "secret_list", "secret_request", "propose_questionnaire"],
  path: "skills/roblox",
  sha256: SHA,
  manifestSha256: SHA,
  installs: [],
}

const detail: CatalogSkillDetail = {
  entry: roblox,
  changelog: [{ version: "1.0.0", date: "2026-10-17", notes: "Primeira versão." }],
  body: "# Roblox\n\nPasso **1**.\n\n<script>alert(1)</script>",
  tools: roblox.tools,
  findings: [],
  installs: [],
}

const botDetail: CatalogBotDetail = {
  entry: { slug: "dev-roblox", name: "Dev Roblox", description: "Luau e Rojo", version: "1.0.0", author: "ali-ali18", category: "games", tags: [], skills: ["roblox"], color: "red", shape: "squircle", path: "bots/dev-roblox", sha256: SHA },
  bot: {
    slug: "dev-roblox",
    name: "Dev Roblox",
    description: "Dev sênior de Roblox.",
    snippet: "Luau e Rojo",
    color: "#FF263C",
    shape: "squircle",
    suggestedModel: "openai/gpt-4o",
    skills: ["roblox"],
    suggestedConnectors: [{ id: "github", reason: "Guardar o projeto." }],
    setupNotes: ["Guarde a chave no cofre."],
    starterRoutines: [
      { name: "Resumo do dia", prompt: "Resuma", cron: "0 9 * * 1-5" },
      { name: "Revisão semanal", prompt: "Revise", cron: "0 18 * * 5" },
    ],
    firstMessage: "Oi!",
    version: "1.0.0",
    author: "ali-ali18",
    category: "games",
    tags: [],
    changelog: [{ version: "1.0.0", notes: "Primeira." }],
  },
  skills: [{ slug: "roblox", name: "Roblox (Luau + Rojo)", description: "Jogos", version: "1.0.0", tools: ["shell"], blocked: false }],
  connectors: [
    { id: "github", reason: "Guardar o projeto.", connected: true },
    { id: "notion", connected: false },
  ],
  findings: [],
}

test("seções do marketplace: Conectores, Apps, Agentes e Habilidades, centradas e com a ativa marcada", () => {
  const html = renderToStaticMarkup(<MarketplaceSections onChange={noop} section="habilidades" />)
  assert.match(html, /role="tablist"/)
  assert.equal((html.match(/role="tab"/g) ?? []).length, 4)
  assert.match(html, /aria-selected="true"[^>]*>Habilidades</)
  assert.match(html, />Conectores</)
  assert.match(html, />Apps</)
  assert.match(html, />Agentes</)
  assert.match(html, /mx-auto/)
  assert.deepEqual([...MARKETPLACE_SECTIONS], ["conectores", "apps", "agentes", "habilidades"])
})

test("estado puro: busca sem acento, categorias, resumo de instalação, escopos, tags e versão", () => {
  const items = [roblox, { ...roblox, slug: "relatorio", name: "Relatório semanal", description: "Monta o relatório da semana", category: "productivity", tags: [], author: "ana" }]
  assert.deepEqual(filterCatalogItems(items, "relatorio", "").map((item) => item.slug), ["relatorio"])
  assert.deepEqual(filterCatalogItems(items, "", "games").map((item) => item.slug), ["roblox"])
  assert.deepEqual(filterCatalogItems(items, "LUAU", "").map((item) => item.slug), ["roblox"])
  assert.deepEqual(categoriesOf(items).map((item) => item.label), ["Jogos", "Produtividade"])
  assert.deepEqual(installSummary([]), { kind: "none" })
  assert.deepEqual(installSummary([install()]), { kind: "installed", version: "1.0.0", count: 1 })
  assert.deepEqual(installSummary([install({ updateAvailable: true, edited: true })]), { kind: "update", installed: "1.0.0", edited: true, count: 1 })
  const scopes = scopeOptions([{ id: "b1", name: "Ana" }], [install({ botId: "b1" })])
  assert.deepEqual(scopes.map((item) => [item.id, item.label, item.hint]), [
    [null, "Minha conta", "Todos os seus agentes podem usar"],
    ["b1", "Ana", "Já instalada aqui"],
  ])
  assert.deepEqual(parseTagInput("Roblox, luau,  Open Cloud, roblox"), ["roblox", "luau", "open-cloud"])
  assert.equal(suggestVersion("1.0.9"), "1.0.10")
  assert.equal(suggestVersion(null), "1.0.0")
  assert.equal(diffLabel(1, 3), "1 linha nova · 3 removidas")
})

test("lista de skills: nome, descrição, autor, versão, categoria, chips de ferramentas e Instalar", () => {
  const html = renderToStaticMarkup(
    <SkillsListView all={[roblox]} category="" error={null} loading={false} onCategory={noop} onInstall={noop} onOpen={noop} skills={[roblox]} />
  )
  assert.match(html, /Roblox \(Luau \+ Rojo\)/)
  assert.match(html, /Desenvolve jogos Roblox/)
  assert.match(html, /por ali-ali18 · Jogos/)
  assert.match(html, />v1\.0\.0</)
  assert.match(html, /Terminal da VM/)
  assert.match(html, />\+1</)
  assert.match(html, /aria-label="Instalar Roblox/)
  assert.match(html, /Filtrar por categoria/)
  assert.match(html, /não libera nenhuma ferramenta nova/i)
})

test("lista de skills: instalada, atualização disponível, vazia, carregando e erro", () => {
  const base = { all: [roblox], category: "", error: null, loading: false, onCategory: noop, onInstall: noop, onOpen: noop }
  const done = renderToStaticMarkup(<SkillsListView {...base} skills={[{ ...roblox, installs: [install()] }]} />)
  assert.match(done, /aria-label="Instalada Roblox/)
  const update = renderToStaticMarkup(<SkillsListView {...base} skills={[{ ...roblox, installs: [install({ updateAvailable: true })] }]} />)
  assert.match(update, /aria-label="Atualizar Roblox/)
  assert.match(renderToStaticMarkup(<SkillsListView {...base} skills={[]} />), /Nenhuma habilidade encontrada/)
  assert.match(renderToStaticMarkup(<SkillsListView {...base} loading skills={null} />), /animate-pulse|data-slot="skeleton"/)
  const failed = renderToStaticMarkup(<SkillsListView {...base} error="O catálogo não respondeu agora." onRetry={noop} skills={null} />)
  assert.match(failed, /O catálogo não respondeu agora/)
  assert.match(failed, /Tentar de novo/)
})

test("página da skill: instruções renderizadas sem HTML cru, ferramentas só como dica, changelog e instalar", () => {
  const html = renderToStaticMarkup(<SkillPageView detail={detail} error={null} loading={false} onBack={noop} onInstall={noop} />)
  assert.match(html, /<strong[^>]*>1<\/strong>/)
  assert.doesNotMatch(html, /<script>alert/)
  assert.match(html, /Ferramentas que ela costuma usar/)
  assert.match(html, /não libera nenhuma ferramenta, conector ou segredo/)
  assert.match(html, /Histórico de versões/)
  assert.match(html, /Primeira versão\./)
  assert.match(html, />Instalar</)
  assert.match(html, /Voltar ao Marketplace/)
})

test("página da skill: atualização disponível com cópia editada e conteúdo bloqueado", () => {
  const update = renderToStaticMarkup(
    <SkillPageView
      detail={{ ...detail, entry: { ...roblox, version: "1.1.0" }, installs: [install({ updateAvailable: true, edited: true })] }}
      error={null}
      loading={false}
      onBack={noop}
      onInstall={noop}
    />
  )
  assert.match(update, /Atualização disponível/)
  assert.match(update, /Você tem a v1\.0\.0; o catálogo está na v1\.1\.0/)
  assert.match(update, /Você editou sua cópia/)
  assert.match(update, />Atualizar</)
  const blocked = renderToStaticMarkup(
    <SkillPageView detail={{ ...detail, findings: [{ rule: "exfiltrate", severity: "block", line: 1, excerpt: "x" }] }} error={null} loading={false} onBack={noop} onInstall={noop} />
  )
  assert.match(blocked, /Conteúdo bloqueado/)
  assert.match(blocked, /disabled=""/)
})

test("lista de agentes: nome, papel, autor, skills e aparência vinda do índice", () => {
  const html = renderToStaticMarkup(
    <BotsListView all={[botDetail.entry]} bots={[botDetail.entry]} category="" error={null} loading={false} onCategory={noop} onInstall={noop} onOpen={noop} />
  )
  assert.match(html, /Dev Roblox/)
  assert.match(html, /por ali-ali18 · Jogos · 1 habilidade/)
  assert.match(html, /aria-label="Instalar Dev Roblox/)
  assert.match(html, /Credenciais nunca vêm no modelo/)
})

test("página do agente: skills, conectores com status, notas e rotinas só como sugestão", () => {
  const html = renderToStaticMarkup(<BotPageView detail={botDetail} error={null} loading={false} onBack={noop} onInstall={noop} />)
  assert.match(html, /Habilidades que ele traz \(1\)/)
  assert.match(html, />Conectado</)
  assert.match(html, />Conectar depois</)
  assert.match(html, /Guarde a chave no cofre/)
  assert.match(html, /Nada é criado sozinho/)
  assert.match(html, /0 9 \* \* 1-5/)
})

test("instalar skill: escopo conta/bot, dica de ferramentas e nenhuma permissão nova", () => {
  const html = renderToStaticMarkup(
    <SkillInstallFlow bots={[{ id: "b1", name: "Ana" }]} busy={false} installs={[]} name="roblox" onClose={noop} onInstall={noop} tools={["shell"]} version="1.0.0" />
  )
  assert.match(html, /role="radiogroup"/)
  assert.equal((html.match(/role="radio"/g) ?? []).length, 2)
  assert.match(html, /aria-checked="true"[^>]*>(?:(?!<\/button>).)*Minha conta/)
  assert.match(html, />Ana</)
  assert.match(html, /Terminal da VM/)
  assert.match(html, /Instalar não libera nenhuma ferramenta nova/)
  assert.match(html, />Instalar<\/button>/)
})

test("instalar skill: com atualização o botão vira Atualizar", () => {
  const html = renderToStaticMarkup(
    <SkillInstallFlow bots={[]} busy={false} installs={[install({ updateAvailable: true })]} name="roblox" onClose={noop} onInstall={noop} tools={[]} version="1.1.0" />
  )
  assert.match(html, />Atualizar<\/button>/)
})

test("cópia editada: resumo das diferenças e as duas escolhas", () => {
  const html = renderToStaticMarkup(
    <SkillConflictFlow
      busy={false}
      catalogVersion="1.1.0"
      diff={{ added: 2, removed: 1, identical: false, preview: ["- Passo 2", "+ Passo 2 melhorado", "+ Passo 4"] }}
      installedVersion="1.0.0"
      name="roblox"
      onChoose={noop}
      onClose={noop}
    />
  )
  assert.match(html, /Você editou sua cópia \(base v1\.0\.0\)/)
  assert.match(html, /2 linhas novas · 1 removida/)
  assert.match(html, /\+ Passo 4/)
  assert.match(html, /Atualizar e perder minhas mudanças/)
  assert.match(html, /Manter a minha/)
})

test("instalar agente: nome editável, modelo padrão, skills, conectores com status e rotinas desmarcadas", () => {
  const html = renderToStaticMarkup(<BotInstallFlow busy={false} detail={botDetail} onClose={noop} onInstall={noop} />)
  assert.match(html, /id="catalog-bot-name"[^>]*value="Dev Roblox"/)
  assert.match(html, /Modelo padrão da conta/)
  assert.match(html, /Habilidades que serão instaladas neste agente/)
  assert.match(html, />github</)
  assert.match(html, />Conectado</)
  assert.match(html, />Conectar depois</)
  assert.match(html, /Nenhuma credencial vem no modelo/)
  assert.match(html, /Rotinas sugeridas \(opcional\)/)
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2)
  assert.doesNotMatch(html, /checked=""/)
  assert.match(html, />Criar agente</)
})

test("instalar agente: rotina marcada vem marcada só quando pedida (teste)", () => {
  const html = renderToStaticMarkup(<BotInstallFlow busy={false} detail={botDetail} initial={{ routines: [1] }} onClose={noop} onInstall={noop} />)
  assert.equal((html.match(/checked=""/g) ?? []).length, 1)
})

test("publicar: formulário, aviso de bloqueio desabilita o envio", () => {
  const defaults = { version: "1.0.1", category: "geral", tags: [], notes: "", author: "ali" }
  const form = renderToStaticMarkup(
    <PublishFlow baseVersion="1.0.0" busy={false} defaults={defaults} findings={[]} name="roblox" onClose={noop} onSubmit={noop} />
  )
  assert.match(form, /Atualização da v1\.0\.0 do catálogo/)
  assert.match(form, /id="publish-version"[^>]*value="1\.0\.1"/)
  assert.match(form, /Publicar no marketplace/)
  assert.match(form, /Segredos, conversas e dados da conta nunca entram/)
  const blocked = renderToStaticMarkup(
    <PublishFlow baseVersion={null} busy={false} defaults={defaults} findings={[{ rule: "ignore-previous", severity: "block", line: 1, excerpt: "x" }]} name="roblox" onClose={noop} onSubmit={noop} />
  )
  assert.match(blocked, /Não dá para publicar/)
  assert.match(blocked, /disabled=""[^>]*>Publicar no marketplace/)
  const review = renderToStaticMarkup(
    <PublishFlow baseVersion={null} busy={false} defaults={defaults} findings={[{ rule: "network-host", severity: "review", line: 1, excerpt: "x" }]} name="roblox" onClose={noop} onSubmit={noop} />
  )
  assert.match(review, /Alguns trechos serão revisados à mão/)
})

test("publicar: resultado com PR aberto e resultado com pacote para baixar", () => {
  const defaults = { version: "1.0.0", category: "geral", tags: [], notes: "x", author: "ali" }
  const pr = renderToStaticMarkup(
    <PublishFlow baseVersion={null} busy={false} defaults={defaults} findings={[]} name="roblox" onClose={noop} onSubmit={noop} result={{ mode: "pr", url: "https://github.com/ali-ali18/agent-skills/pull/9", number: 9 }} />
  )
  assert.match(pr, /Pull request aberto/)
  assert.match(pr, /href="https:\/\/github.com\/ali-ali18\/agent-skills\/pull\/9"/)
  assert.match(pr, /rel="noopener noreferrer"/)
  const pack = renderToStaticMarkup(
    <PublishFlow
      baseVersion={null}
      busy={false}
      defaults={defaults}
      findings={[]}
      name="roblox"
      onClose={noop}
      onSubmit={noop}
      result={{ mode: "package", reason: "github_not_connected", message: "Conecte o GitHub.", slug: "roblox", files: [{ path: "skills/roblox/SKILL.md", content: "x" }], newPrUrl: "https://github.com/ali-ali18/agent-skills/compare" }}
    />
  )
  assert.match(pack, /Pacote pronto para enviar/)
  assert.match(pack, /skills\/roblox\/SKILL\.md/)
  assert.match(pack, /Baixar pacote \(\.zip\)/)
  assert.match(pack, /Abrir página do PR/)
})

test("409 de cópia editada é reconhecido; outros erros não", () => {
  const conflict = { code: "edited", installedVersion: "1.0.0", catalogVersion: "1.1.0", diff: { added: 1, removed: 0, identical: false, preview: [] } }
  assert.deepEqual(catalogEditedConflict(new AtlasApiError("x", 409, conflict))?.catalogVersion, "1.1.0")
  assert.equal(catalogEditedConflict(new AtlasApiError("x", 409, { code: "name_taken" })), null)
  assert.equal(catalogEditedConflict(new AtlasApiError("x", 500, conflict)), null)
  assert.equal(catalogEditedConflict(new Error("x")), null)
})

test("zip: assinatura, entradas e crc32 conferem", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926)
  const bytes = createZip([
    { path: "skills/roblox/SKILL.md", content: "olá" },
    { path: "index.json", content: "{}" },
  ])
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.equal(view.getUint32(0, true), 0x04034b50)
  const end = bytes.byteLength - 22
  assert.equal(view.getUint32(end, true), 0x06054b50)
  assert.equal(view.getUint16(end + 10, true), 2)
  const text = new TextDecoder().decode(bytes)
  assert.ok(text.includes("skills/roblox/SKILL.md"))
  assert.ok(text.includes("olá"))
})

test("categorias traduzidas e ordenadas pelo rótulo traduzido do idioma da tela", async () => {
  const items = [{ category: "productivity" }, { category: "games" }, { category: "dev" }, { category: "quadrinhos-x" }]
  const en = createTranslator("en-US", await loadMessages("en-US"))
  assert.deepEqual(categoriesOf(items, en).map((item) => item.label), ["Development", "Games", "Productivity", "Quadrinhos x"])
  const es = createTranslator("es-ES", await loadMessages("es-ES"))
  assert.deepEqual(categoriesOf(items, es).map((item) => item.label), ["Desarrollo", "Juegos", "Productividad", "Quadrinhos x"])
  assert.equal(categoryLabel("games", en), "Games")
  assert.equal(categoryLabel("games"), "Jogos")
  assert.equal(categoryLabel("constructor", en), "Constructor")
})
