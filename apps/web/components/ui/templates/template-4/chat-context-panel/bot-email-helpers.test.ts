import assert from "node:assert/strict";
import test from "node:test";
import { EMAIL_ALLOWED_SENDERS_MAX } from "@workspace/shared";
import { addAllowedSender, emailOpensConversation, emailPeer, emailStatusBadge, emailSubject, filterAllowedSenders, moreSendersLabel, parseDailyLimit, previewAllowedSenders } from "./bot-email-helpers";

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

test("prévia dos remetentes: primeiro fixo, 4 mais recentes (fim da lista) sem repetir o primeiro", () => {
	assert.deepEqual(previewAllowedSenders([]), { first: null, recent: [], more: 0 });
	assert.deepEqual(previewAllowedSenders(["a@x.co"]), { first: "a@x.co", recent: [], more: 0 });
	assert.deepEqual(previewAllowedSenders(["a@x.co", "b@x.co", "c@x.co"]), { first: "a@x.co", recent: ["c@x.co", "b@x.co"], more: 2 });
	const many = Array.from({ length: 12 }, (_, i) => `u${i}@x.co`);
	assert.deepEqual(previewAllowedSenders(many), { first: "u0@x.co", recent: ["u11@x.co", "u10@x.co", "u9@x.co", "u8@x.co"], more: 11 });
	assert.equal(moreSendersLabel(1), "+1 remetente");
	assert.equal(moreSendersLabel(11), "+11 remetentes");
});

test("busca de remetentes: sem caixa nem acento; vazio devolve tudo", () => {
	const list = ["ana@empresa.com", "@parceiro.com.br", "JOSÉ@x.co"];
	assert.deepEqual(filterAllowedSenders(list, ""), list);
	assert.deepEqual(filterAllowedSenders(list, " PARCEIRO "), ["@parceiro.com.br"]);
	assert.deepEqual(filterAllowedSenders(list, "jose"), ["JOSÉ@x.co"]);
	assert.deepEqual(filterAllowedSenders(list, "zzz"), []);
});

test("limite de remetentes: 1000, com erro claro ao passar", () => {
	assert.equal(EMAIL_ALLOWED_SENDERS_MAX, 1000);
	const full = Array.from({ length: EMAIL_ALLOWED_SENDERS_MAX }, (_, i) => `u${i}@x.co`);
	assert.equal(addAllowedSender(full, "novo@x.co").ok, false);
	assert.equal(addAllowedSender(full.slice(1), "novo@x.co").ok, true);
});
