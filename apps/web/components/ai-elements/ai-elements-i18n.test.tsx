import React from "react"
Object.assign(globalThis, { React })
import assert from "node:assert/strict"
import { test } from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { loadMessages } from "@/lib/i18n/messages"
import { I18nProvider } from "@/lib/i18n/provider"
import { createTranslator } from "@/lib/i18n/translator"
import { LoginCard } from "./login/login-card"
import { BotNeedsUserCardView } from "./bot-messages/bot-needs-user-card"
import { describeAction, describeContext, RunInspectorView } from "./run-inspector/run-inspector-view"
import { DevApprovalCard } from "./dev-session/dev-approval-card"
import { ActiveWorkRowView } from "./dev-session/active-work"
import { ciSummaryLabel } from "@/lib/shared-labels"
import { PageShareBody } from "./pages/page-share-dialog"
import { SkillProposalCard } from "./skills/skill-proposal-card"
import { proposalErrorMessage } from "./skills/skill-proposal"
import { subagentsHeadline, subagentsWaitingLabel } from "./subagents/subagents-block"
import { getProposalTitle } from "./confirm/bot-profile-proposal"
import { githubIdentityText } from "./confirm/github-identity-card"

async function wrap(locale: "en-US" | "es-ES", node: React.ReactNode) {
  return renderToStaticMarkup(<I18nProvider locale={locale} messages={await loadMessages(locale)}>{node}</I18nProvider>)
}
const translator = async (locale: "en-US" | "es-ES") => createTranslator(locale, await loadMessages(locale))

test("cartão de login e pedido de bot delegado no idioma da tela", async () => {
  const en = await wrap("en-US", <LoginCard site="example.com" />)
  assert.match(en, /I need you to sign in to example\.com/)
  assert.match(en, />Open the VM</)
  assert.match(en, />I&#x27;m done</)
  assert.doesNotMatch(en, /Abrir a VM|Terminei|Precisa de você/)
  const needs = await wrap(
    "es-ES",
    <BotNeedsUserCardView bot={{ id: "b", name: "Ana" }} need={{ type: "login", label: "Entrar", conversationId: "c" } as never} onOpenVm={() => undefined} status="pending" />,
  )
  assert.match(needs, /Ana te necesita/)
  assert.match(needs, /Abrir la VM/)
})

test("inspetor da execução: ações, contexto e tela em en-US", async () => {
  const en = await translator("en-US")
  assert.equal(describeAction({ kind: "trimmed", count: 1 }, en), "Trimmed 1 message")
  assert.equal(describeAction({ kind: "compact", before: 48_200, after: 6_100 }, en), "Conversation compacted (48k to 6.1k)")
  assert.equal(describeContext({ mode: "fallback", reason: "disabled" }, en), "Text-only history: turned off")
  const inspection = { model: "m", status: "ok", totals: { steps: 0, toolCalls: 0, failedToolCalls: 0, promptTokens: 1500, completionTokens: 20 }, steps: [], toolCalls: [], approvals: [], errors: [] } as never
  const html = await wrap("en-US", <RunInspectorView copied inspection={inspection} onCopy={() => undefined} />)
  assert.match(html, /Calls \(0\)/)
  assert.match(html, /1\.5k \/ 20/)
  assert.match(html, /Copied/)
  assert.doesNotMatch(html, /Chamadas|Copiado/)
})

test("lista Em andamento e linha de trabalho no idioma da tela", async () => {
  const row = { key: "k", item: { kind: "dev", id: "1" }, title: "o/r", conversation: "Ana", state: "waiting", startedAt: 0, awaitingApproval: true, unread: false } as never
  const html = await wrap("en-US", <ActiveWorkRowView now={5000} onOpen={() => undefined} row={row} />)
  assert.match(html, /aria-label="Open o\/r in the conversation Ana"/)
  assert.match(html, /Waiting for approval/)
  assert.doesNotMatch(html, /Aguardando/)
})

test("aprovação de comando e resumo de checks do PR no idioma da tela", async () => {
  const info = { kind: "command" as const, command: "pnpm test", cwd: "/w", repo: "o/r", branch: "main", reason: "r", prefixes: ["pnpm test"] }
  const html = await wrap("en-US", <DevApprovalCard info={info} onAlways={() => undefined} onConfirm={() => undefined} title="Run?" />)
  assert.match(html, />Run</)
  assert.match(html, /aria-label="More options"/)
  assert.match(html, /Needs you/)
  assert.match(html, /in \/w/)
  const en = await translator("en-US")
  const es = await translator("es-ES")
  const check = (conclusion: string) => ({ status: "completed" as const, conclusion })
  assert.equal(ciSummaryLabel([], en), "No checks")
  assert.equal(ciSummaryLabel([check("success"), check("failure")], en), "1 failed · 1 of 2 passed")
  assert.equal(ciSummaryLabel([check("success"), check("success")], es), "2 de 2 pasaron")
})

test("link público, proposta de habilidade e erros no idioma da tela", async () => {
  const share = await wrap("en-US", <PageShareBody busy={false} copied={false} onCopy={() => undefined} onRotate={() => undefined} onToggle={() => undefined} state={{ kind: "ready", active: true, url: null }} />)
  assert.match(share, /Public link/)
  assert.match(share, /Anyone with the link can see this panel/)
  assert.match(share, /Generate new link/)
  const proposal = { proposalId: "p", action: "create", name: "resumo", description: "d", body: "b", tools: [], botId: null, status: "pending" } as never
  const skill = await wrap("es-ES", <SkillProposalCard proposal={proposal} />)
  assert.match(skill, /Crear habilidad/)
  assert.match(skill, /Crear la habilidad «resumo» para tu cuenta\./)
  const en = await translator("en-US")
  assert.equal(proposalErrorMessage({ status: 404 }, en), "This proposal no longer exists or was already resolved.")
})

test("subagentes, perfil do bot e GitHub no idioma da tela", async () => {
  const en = await translator("en-US")
  const tasks = [{ status: "ok" }, { status: "failed" }, { status: "running" }] as never
  assert.equal(subagentsWaitingLabel(tasks, en), "Waiting for the subagents' answers (2 of 3)")
  assert.equal(subagentsHeadline(tasks, en), "3 subagents · 1 failed")
  const proposal = { botId: "b", before: { name: "A", snippet: "", description: null, openRouterModel: null }, after: { name: "B" }, fields: ["name"] } as never
  assert.equal(getProposalTitle(proposal, en), "Update name?")
  assert.equal(githubIdentityText({ reason: "no_permission", repo: "o/r", appName: "app" } as never, en).confirmLabel, "Done, I accepted")
})

