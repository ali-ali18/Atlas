import assert from "node:assert/strict";
import test from "node:test";
import { addAllowedSender, emailOpensConversation, emailPeer, emailStatusBadge, emailSubject, parseDailyLimit } from "./bot-email-helpers";

test("adicionar remetente: normaliza, aceita domínio e recusa lixo e duplicados", () => {
	assert.deepEqual(addAllowedSender(["a@b.co"], " Ana@Empresa.com "), { ok: true, next: ["a@b.co", "ana@empresa.com"] });
	assert.deepEqual(addAllowedSender([], "@parceiro.com.br"), { ok: true, next: ["@parceiro.com.br"] });
	assert.equal(addAllowedSender([], "lixo").ok, false);
	assert.equal(addAllowedSender(["a@b.co"], "A@B.co").ok, false);
});

test("limite diário: só inteiros de 0 a 200", () => {
	assert.equal(parseDailyLimit("20"), 20);
	assert.equal(parseDailyLimit("0"), 0);
	assert.equal(parseDailyLimit("201"), null);
	assert.equal(parseDailyLimit("-1"), null);
	assert.equal(parseDailyLimit("2,5"), null);
});

test("linhas de mensagem: direção, assunto, selo e se abre a conversa", () => {
	assert.equal(emailPeer({ direction: "in", from: "a@b.co", to: ["x@y.co"] }), "De a@b.co");
	assert.equal(emailPeer({ direction: "out", from: "x@y.co", to: ["a@b.co", "c@d.co"] }), "Para a@b.co, c@d.co");
	assert.equal(emailSubject({ subject: "  " }), "(sem assunto)");
	assert.deepEqual(emailStatusBadge({ status: "blocked" }), { label: "Bloqueado", tone: "danger" });
	assert.equal(emailStatusBadge({ status: "received" }), null);
	assert.equal(emailOpensConversation({ conversationId: "c", status: "received" }), true);
	assert.equal(emailOpensConversation({ conversationId: null, status: "blocked" }), false);
	assert.equal(emailOpensConversation({ conversationId: "c", status: "blocked" }), false);
});
