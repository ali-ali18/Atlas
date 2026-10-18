import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { persistConversationCardFromEvent } from "./conversations.js";
import { updateDevSession } from "./dev-sessions.js";
import { approvalDetail, installPushListener, setPushEventListener, type PushEvent } from "./user-needed.js";
import { createNotifier } from "./push.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";

let installed: { restore: () => void };
let events: PushEvent[];
let devSessions: FakeTable;

beforeEach(() => {
	events = [];
	setPushEventListener((event) => void events.push(event));
	devSessions = new FakeTable([{ id: "d1", userId: "u1", conversationId: "c1", status: "RUNNING", lastError: null }]);
	installed = installFakes({
		conversation: new FakeTable([{ id: "c1", userId: "u1" }]),
		conversationMessage: new FakeTable([], () => ({ createdAt: new Date() })),
		devSession: devSessions,
	});
});
afterEach(() => {
	setPushEventListener(null);
	installed.restore();
});

test("detalhe da aprovação: comando, arquivo ou título", () => {
	assert.equal(approvalDetail({ title: "Rodar testes", devApproval: { kind: "command", command: "pnpm test" } }), "Executar · pnpm test");
	assert.equal(approvalDetail({ title: "x", devApproval: { kind: "edit", path: "src/a.ts" } }), "Editar · src/a.ts");
	assert.equal(approvalDetail({ title: "Enviar e-mail" }), "Enviar e-mail");
});

test("cartão de aprovação pendente avisa; decidido não", async () => {
	await persistConversationCardFromEvent("c1", { type: "confirm", confirmId: "k1", title: "Enviar e-mail", status: "pending" });
	await persistConversationCardFromEvent("c1", { type: "confirm", confirmId: "k2", title: "Antigo", status: "approved" });
	assert.deepEqual(events, [{ kind: "needs-user", conversationId: "c1", cardId: "k1", detail: "Enviar e-mail" }]);
});

test("pedido de segredo e login também avisam", async () => {
	await persistConversationCardFromEvent("c1", { type: "login", loginId: "l1", site: "github.com", url: "https://github.com/login" });
	assert.deepEqual(events.map((event) => [event.kind, (event as { cardId?: string }).cardId]), [["needs-user", "l1"]]);
});

test("sessão de código em ERROR avisa uma vez, com o motivo", async () => {
	await updateDevSession("d1", { status: "RUNNING" });
	await updateDevSession("d1", { status: "ERROR", lastError: "container saiu com 137" });
	assert.deepEqual(events, [{ kind: "coding-failed", conversationId: "c1", userId: "u1", detail: "container saiu com 137" }]);
});

test("o ouvinte instalado chama notify com o dono da conversa e o cartão", async () => {
	const calls: unknown[][] = [];
	installPushListener((async (...args: unknown[]) => (calls.push(args), { status: "sent" })) as unknown as ReturnType<typeof createNotifier>);
	await persistConversationCardFromEvent("c1", { type: "confirm", confirmId: "k1", title: "Enviar e-mail", status: "pending" });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(calls, [["u1", "c1", "needs-user", "Enviar e-mail", { cardId: "k1" }]]);
});
