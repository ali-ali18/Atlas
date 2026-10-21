import assert from "node:assert/strict";
import test from "node:test";
import { diffRoutineUpdatePayload, hookUrlWithSecret, routineScheduleSummary, routinePrimaryTriggerKind, routineRunLabel, routineTriggerRows, uiRoutineToPayload, webhookAuthHeader } from "./routine-map";
import type { Routine } from "../data";
const routine: Routine = { id: "fixture", name: "Rotina", instruction: "Teste", model: "chatgpt/luna", active: true, triggerKind: "once", triggers: [] };
test("rotina não usa assinatura sem opt-in explícito", () => {
 assert.equal(uiRoutineToPayload(routine).allowChatgptPlan, false);
 assert.equal(uiRoutineToPayload({ ...routine, allowChatgptPlan: true }).allowChatgptPlan, true);
});
test("autosave de opt-in não sobrescreve outros campos", () => {
 const before = uiRoutineToPayload(routine);
 assert.deepEqual(diffRoutineUpdatePayload({ ...before, allowChatgptPlan: true }, before), { allowChatgptPlan: true });
 assert.deepEqual(diffRoutineUpdatePayload(before, { ...before, allowChatgptPlan: undefined }), {});
});
test("aviso: padrão sempre, e só entra no PATCH quando muda", () => {
 assert.equal(uiRoutineToPayload(routine).notify, "always");
 assert.equal(uiRoutineToPayload({ ...routine, notify: "important" }).notify, "important");
 const before = uiRoutineToPayload(routine);
 assert.deepEqual(diffRoutineUpdatePayload({ ...before, notify: "important" }, before), { notify: "important" });
 assert.deepEqual(diffRoutineUpdatePayload(before, { ...before, notify: undefined }), {});
});
test("hookUrlWithSecret embute o secret na query (codificado)", () => {
 assert.equal(hookUrlWithSecret("https://x.test/v1/hooks/k", "a b&c"), "https://x.test/v1/hooks/k?secret=a%20b%26c");
 assert.equal(hookUrlWithSecret("https://x.test/v1/hooks/k?a=1", "s"), "https://x.test/v1/hooks/k?a=1&secret=s");
});
test("histórico mostra gatilho e motivo de execução pulada/adiada", () => {
 assert.match(routineRunLabel({ status: "skipped", triggeredBy: "event", error: "O bot já está ocupado" }), /pulada · O bot já está ocupado/);
 assert.match(routineRunLabel({ status: "queued", triggeredBy: "event", error: null }), /na fila/);
});
test("webhookAuthHeader monta o cabeçalho Bearer", () => {
 assert.equal(webhookAuthHeader("k1"), "Authorization: Bearer k1");
});
test("gatilhos: tipo e linhas por tipo de rotina", () => {
 const webhook: Routine = { ...routine, triggerKind: "event", triggers: [{ id: "webhook", text: "Webhook" }] };
 assert.equal(routinePrimaryTriggerKind(webhook), "webhook");
 assert.equal(routineTriggerRows(webhook)[0]?.kind, "webhook");
 const github: Routine = { ...routine, triggerKind: "event", triggers: [{ id: "github", text: "GitHub" }], github: { repo: "a/b", events: ["pr_opened"], prNumber: "", users: "", ciBranch: "" } };
 assert.equal(routinePrimaryTriggerKind(github), "github");
 assert.ok(routineTriggerRows(github).length > 0);
 const once: Routine = { ...routine, triggers: [{ id: "once", text: "amanhã às 9h" }] };
 assert.deepEqual(routineTriggerRows(once), [{ kind: "cron", text: "Amanhã às 9h" }]);
 assert.deepEqual(routineTriggerRows(routine), []);
});
test("resumo do agendamento por tipo de rotina", () => {
 const once: Routine = { ...routine, triggers: [{ id: "once", text: "amanhã às 9h" }] };
 assert.equal(routineScheduleSummary(once), "Amanhã às 9h");
 assert.equal(routineScheduleSummary(routine), "Sem gatilho");
 assert.equal(routineScheduleSummary({ ...routine, triggerKind: "event", triggers: [{ id: "webhook", text: "Webhook" }] }), "Webhook");
 assert.equal(routineScheduleSummary({ ...routine, triggerKind: "event", triggers: [{ id: "github", text: "GitHub" }], github: { repo: "a/b", events: ["pr_opened"], prNumber: "", users: "", ciBranch: "" } }), "GitHub · a/b");
});
