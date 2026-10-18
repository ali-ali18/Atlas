import assert from "node:assert/strict"
import test from "node:test"
import { checkLabel, commitLabel, versionFooter, webVersion, missingFeaturesLabel, queuesLabel, uptimeLabel, versionMismatch, webCommitShort } from "./diagnostics-state"

const api = (commitShort: string) => ({ service: "api", version: "0.1.0-beta", commit: commitShort, commitShort, startedAt: "", uptimeSec: 1, node: "v22" })
const worker = (up: boolean, commitShort: string | null) => ({ up, version: null, commit: commitShort, commitShort, startedAt: null, lastBeatAt: null })

test("rótulos de commit e uptime", () => {
  assert.equal(commitLabel("abc1234"), "abc1234")
  assert.equal(commitLabel("dev"), "")
  assert.equal(commitLabel(null), "")
  assert.equal(webCommitShort("0123456789abcdef0123456789abcdef01234567"), "0123456")
  assert.equal(webCommitShort(""), null)
  assert.equal(uptimeLabel(30), "30s")
  assert.equal(uptimeLabel(600), "10 min")
  assert.equal(uptimeLabel(7200), "2 h")
  assert.equal(uptimeLabel(3 * 86400), "3 dias")
})

test("estado dos serviços", () => {
  assert.equal(checkLabel({ ok: true, ms: 4 }), "ok · 4 ms")
  assert.equal(checkLabel({ ok: false, ms: null, error: "ECONNREFUSED" }), "fora · ECONNREFUSED")
  assert.equal(queuesLabel(null), "indisponível")
  assert.equal(queuesLabel([{ name: "a", waiting: 2, active: 1, delayed: 0, failed: 0 }, { name: "b", waiting: 1, active: 0, delayed: 0, failed: 3 }]), "1 rodando · 3 na fila · 3 com falha")
})

test("versões diferentes entre api, worker e web", () => {
  assert.equal(versionMismatch({ api: api("abc1234"), worker: worker(true, "abc1234") }, "abc1234"), false)
  assert.equal(versionMismatch({ api: api("abc1234"), worker: worker(true, "def5678") }, "abc1234"), true)
  assert.equal(versionMismatch({ api: api("abc1234"), worker: worker(false, null) }, null), false)
  assert.equal(versionMismatch({ api: api("dev"), worker: worker(true, "abc1234") }, null), false)
})

test("recursos faltando", () => {
  assert.equal(missingFeaturesLabel([{ id: "push", label: "Push", configured: true, missing: [] }]), "tudo configurado")
  assert.equal(missingFeaturesLabel([{ id: "push", label: "Push", configured: false, missing: ["X"] }, { id: "s", label: "Sentry", configured: false, missing: ["Y"] }]), "Push, Sentry")
})

test("rodapé de versão", () => {
  assert.equal(versionFooter("0.1.0-beta", "abc1234"), "Versão 0.1.0-beta · abc1234")
  assert.equal(versionFooter("0.1.0-beta", null), "Versão 0.1.0-beta")
  assert.equal(versionFooter(null, "abc1234"), "Versão abc1234")
  assert.equal(webVersion("0.1.0-beta"), "0.1.0-beta")
  assert.equal(webVersion(""), null)
})
