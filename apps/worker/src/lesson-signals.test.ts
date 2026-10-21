import assert from "node:assert/strict";
import { test } from "node:test";
import type { InspectRawStep } from "@workspace/shared";
import { detectRunSignals } from "./lesson-signals.js";
import { shouldReviewLessons } from "./lesson-trigger.js";

let seq = 0;
function result(tool: string, ok: boolean, summary: string, args: unknown = {}, decisionIndex = ++seq): InspectRawStep {
	return { index: decisionIndex, decisionIndex, subIndex: 1, type: "tool_result", status: ok ? "completed" : "failed", inputJson: { name: tool, args }, outputJson: { ok, summary }, idempotencyKey: `k${decisionIndex}` };
}
const run = (steps: InspectRawStep[], approvals: Array<{ id: string; content: string }> = []) => ({ runId: "run-1", steps, approvals });
const card = (status: string, extra: Record<string, unknown> = {}) => ({ id: "m1", content: JSON.stringify({ v: 1, kind: "confirm", confirmId: "c1", title: "Enviar e-mail", status, ...extra }) });

test("falha seguida de sucesso da mesma ferramenta vira sinal de recuperação (uma por ferramenta)", () => {
	seq = 0;
	const out = detectRunSignals([run([result("api_call", false, "400 id inválido", { id: 1 }), result("api_call", false, "400 id inválido", { id: 2 }), result("api_call", true, "ok", { id: 99 }), result("web_fetch", true, "ok")])]);
	const recoveries = out.signals.filter((s) => s.kind === "recovery");
	assert.equal(recoveries.length, 1);
	assert.deepEqual(recoveries[0], { kind: "recovery", tool: "api_call", runId: "run-1", step: 1, failedArgs: '{"id":1}', error: "400 id inválido", succeededArgs: '{"id":99}' });
	assert.deepEqual(out.slice.failureTexts, ["400 id inválido", "400 id inválido"]);
	assert.equal(out.slice.toolTexts?.length, 4);
});

test("sucesso antes da falha não é recuperação; falha sem sucesso depois também não", () => {
	seq = 0;
	assert.deepEqual(detectRunSignals([run([result("a", true, "ok"), result("a", false, "erro")])]).signals, []);
	assert.deepEqual(detectRunSignals([run([result("a", false, "erro")])]).signals, []);
});

test("mesma chamada falhando duas vezes vira falha repetida; argumentos diferentes não", () => {
	seq = 0;
	const same = detectRunSignals([run([result("mcp__x__send", false, "to obrigatório", { b: 1 }), result("mcp__x__send", false, "to obrigatório", { b: 1 })])]);
	assert.deepEqual(same.signals.map((s) => s.kind), ["repeated_failure"]);
	seq = 0;
	const different = detectRunSignals([run([result("mcp__x__send", false, "to obrigatório", { b: 1 }), result("mcp__x__send", false, "to obrigatório", { b: 2 })])]);
	assert.deepEqual(different.signals, []);
});

test("cartão de aprovação que falhou ou foi recusado vira sinal", () => {
	seq = 0;
	const out = detectRunSignals([run([], [card("failed", { outcome: { ok: false, detail: "403 sem permissão" } }), card("rejected"), card("approved")])]);
	assert.deepEqual(out.signals.map((s) => s.kind), ["failed_action", "rejected_action"]);
	assert.deepEqual(out.slice.failureTexts, ["403 sem permissão"]);
});

test("registra as skills lidas com sucesso e ignora ferramentas internas", () => {
	seq = 0;
	const out = detectRunSignals([run([result("skill_read", true, "ok", { name: "relatorio-mensal" }), result("skill_read", false, "sem skill", { name: "nao-existe" }), result("lesson_feedback", false, "x"), result("context_summary", false, "x")])]);
	assert.deepEqual(out.skillsRead, ["relatorio-mensal"]);
	assert.equal(out.outcomes.some((o) => o.tool === "lesson_feedback" || o.tool === "context_summary"), false);
});

test("junta o início da chamada (type tool) quando o resultado não traz o nome", () => {
	const start: InspectRawStep = { index: 1, decisionIndex: 1, subIndex: 1, type: "tool", status: "completed", inputJson: { name: "web_fetch", args: { url: "x" } }, outputJson: null, idempotencyKey: "kk" };
	const end: InspectRawStep = { index: 2, decisionIndex: 1, subIndex: 1, type: "tool_result", status: "failed", inputJson: null, outputJson: { ok: false, summary: "timeout" }, idempotencyKey: "kk" };
	const out = detectRunSignals([run([start, end])]);
	assert.equal(out.outcomes[0]?.tool, "web_fetch");
	assert.equal(out.outcomes[0]?.ok, false);
});

test("gatilho: só chat com bot e conversa, e com turno anterior do bot ou falha de ferramenta", () => {
	const base = { origin: "chat", hasBot: true, hasConversation: true, groupRun: false, onboardingRun: false, priorAssistantTurn: true, failedToolCalls: 0 };
	assert.equal(shouldReviewLessons(base), true);
	assert.equal(shouldReviewLessons({ ...base, priorAssistantTurn: false }), false);
	assert.equal(shouldReviewLessons({ ...base, priorAssistantTurn: false, failedToolCalls: 1 }), true);
	for (const off of [{ origin: "routine" }, { hasBot: false }, { hasConversation: false }, { groupRun: true }, { onboardingRun: true }]) {
		assert.equal(shouldReviewLessons({ ...base, failedToolCalls: 3, ...off }), false);
	}
});
