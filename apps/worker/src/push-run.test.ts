import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_HOOK_PEPPER ||= "p";
process.env.ATLAS_OWNER_EMAIL ||= "o@t.l";

const { pushKindForOrigin, shouldPushRunEnd } = await import("./processors/agent-run.js");
const { resolveUserPushForRun } = await import("./proactive-run.js");

test("fim de run só avisa com conversa, texto, notificador e fora de subagente", () => {
	assert.equal(shouldPushRunEnd({ conversationId: "c1", origin: "chat" }, "Pronto"), true);
	assert.equal(shouldPushRunEnd({ conversationId: null, origin: "chat" }, "Pronto"), false);
	assert.equal(shouldPushRunEnd({ conversationId: "c1", origin: "chat" }, "  \n"), false);
	assert.equal(shouldPushRunEnd({ conversationId: "c1", origin: "subagent" }, "Pronto"), false);
	assert.equal(shouldPushRunEnd({ conversationId: "c1", origin: "chat" }, "Pronto", false), false);
});

test("lembrete, rotina e webhook viram 'lembrete'; conversa normal 'terminou'", () => {
	assert.equal(pushKindForOrigin("proactive"), "reminder");
	assert.equal(pushKindForOrigin("routine"), "reminder");
	assert.equal(pushKindForOrigin("webhook"), "reminder");
	assert.equal(pushKindForOrigin("chat"), "run-finished");
	assert.equal(pushKindForOrigin(undefined), "run-finished");
});

test("rotina 'important' não recebe push automático ao fim; 'always' segue igual", () => {
	const run = { conversationId: "c1", origin: "routine" };
	assert.equal(shouldPushRunEnd(run, "Resultado", true, "important"), false);
	assert.equal(shouldPushRunEnd(run, "Resultado", true, "always"), true);
	assert.equal(shouldPushRunEnd(run, "Resultado"), true);
	// o modo só vale para rotina
	assert.equal(shouldPushRunEnd({ conversationId: "c1", origin: "chat" }, "Pronto", true, "important"), true);
});

test("push avulso: rotina só no modo important, chat sempre, nunca em grupo/sem notifier/sem conversa", () => {
	const send = async () => undefined;
	const base = { isGroupRun: false, hasConversation: true, routineNotify: "always" as const, policyJson: null, send };
	assert.equal(resolveUserPushForRun({ ...base, origin: "routine" }), undefined);
	assert.equal(resolveUserPushForRun({ ...base, origin: "routine", routineNotify: "important" })?.mode, "routine");
	assert.equal(resolveUserPushForRun({ ...base, origin: "chat" })?.mode, "chat");
	assert.equal(resolveUserPushForRun({ ...base, origin: "proactive" }), undefined);
	assert.equal(resolveUserPushForRun({ ...base, origin: "chat", isGroupRun: true }), undefined);
	assert.equal(resolveUserPushForRun({ ...base, origin: "chat", send: undefined }), undefined);
	assert.equal(resolveUserPushForRun({ ...base, origin: "chat", hasConversation: false }), undefined);
});

test("push avulso só leva silêncio quando o modo proativo está ligado", () => {
	const send = async () => undefined;
	const base = { origin: "chat", isGroupRun: false, hasConversation: true, routineNotify: "always" as const, send };
	assert.equal(resolveUserPushForRun({ ...base, policyJson: null })?.quiet, undefined);
	const on = resolveUserPushForRun({ ...base, policyJson: { proactive: { enabled: true, quietStart: "21:00", quietEnd: "07:00" } } });
	assert.equal(on?.quiet?.quietStart, "21:00");
});

test("rotina de alerta nunca avisa no fim da execução: quem avisa é o veredito, só na virada", () => {
	const run = { conversationId: "c1", origin: "routine" };
	assert.equal(shouldPushRunEnd(run, "⚠️ Estoque: 7 un.", true, "always", true), false);
	assert.equal(shouldPushRunEnd(run, "Resultado", true, "always", false), true);
});

test("o push de alerta e o de falha de rotina têm kinds próprios (⚠️ no título)", async () => {
	const { buildPushPayload } = await import("@workspace/shared");
	assert.equal(buildPushPayload({ kind: "alert", conversationId: "c1", botId: "b1", botName: "Adolfinho", text: "⚠️ Estoque: 7 un." })?.title, "⚠️ Adolfinho");
	assert.equal(buildPushPayload({ kind: "routine-failed", conversationId: "c1", botId: "b1", botName: "Adolfinho", text: "x" })?.kind, "routine-failed");
});
