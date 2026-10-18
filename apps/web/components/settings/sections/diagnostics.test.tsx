import assert from "node:assert/strict"
import test from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { DiagnosticsView } from "@workspace/shared"
import { DiagnosticsSettingsView } from "./diagnostics"

Object.assign(globalThis, { React })

const view: DiagnosticsView = {
  generatedAt: "2026-10-15T12:00:00.000Z",
  api: { service: "api", version: "0.1.0-beta", commit: "abc1234", commitShort: "abc1234", startedAt: "2026-10-15T11:00:00.000Z", uptimeSec: 3600, node: "v22" },
  worker: { up: true, version: null, commit: "def5678", commitShort: "def5678", startedAt: null, lastBeatAt: null },
  services: { postgres: { ok: true, ms: 3 }, redis: { ok: false, ms: null, error: "ECONNREFUSED" }, queues: [{ name: "agent-runs", waiting: 1, active: 0, delayed: 0, failed: 2 }] },
  push: { enabled: false, problems: ["WEB_PUSH_PUBLIC_KEY ausente"], subscriptions: 0 },
  sentry: { enabled: false },
  providers: [
    { id: "openrouter", label: "OpenRouter", present: true, source: "server" },
    { id: "anthropic", label: "Anthropic (API)", present: false, source: "none" },
  ],
  env: [{ id: "push", label: "Notificações push", configured: false, missing: ["WEB_PUSH_PUBLIC_KEY"] }],
  failures: [{ kind: "routine", id: "r1", label: "Resumo diário", reason: "OpenRouter recusou a chave", at: "2026-10-15T11:30:00.000Z" }],
}

const base = { loading: false, error: null, onRefresh: () => {}, webCommit: "abc1234", webVersion: "0.1.0-beta" }

test("mostra versões, serviços, chaves (sim/não) e falhas, e avisa de versões diferentes", () => {
  const html = renderToStaticMarkup(<DiagnosticsSettingsView {...base} data={view} />)
  assert.match(html, /abc1234 · ligada há 1 h/)
  assert.match(html, /def5678 · ativo/)
  assert.match(html, /fora · ECONNREFUSED/)
  assert.match(html, /1 rodando|0 rodando · 1 na fila · 2 com falha/)
  assert.match(html, /desligadas no servidor/)
  assert.match(html, /presente \(servidor\)/)
  assert.match(html, /ausente/)
  assert.match(html, /Rotina · Resumo diário/)
  assert.match(html, /OpenRouter recusou a chave/)
  assert.match(html, /Versões diferentes/)
  assert.match(html, /Versão 0.1.0-beta · abc1234/)
  assert.doesNotMatch(html, /WEB_PUSH_PUBLIC_KEY/, "nomes de variáveis não vão para a tela")
})

test("sem dados mostra só o cabeçalho; erro aparece como alerta; some quando a busca não bate", () => {
  const empty = renderToStaticMarkup(<DiagnosticsSettingsView {...base} data={null} error="Não foi possível carregar o diagnóstico." />)
  assert.match(empty, /role="alert"/)
  assert.doesNotMatch(empty, /Postgres/)
  assert.equal(renderToStaticMarkup(<DiagnosticsSettingsView {...base} data={view} isVisible={() => false} />), "")
})
