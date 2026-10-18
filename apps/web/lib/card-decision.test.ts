import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import type { Message } from "@/components/ui/templates/template-4/data";
import { beginCardDecision, cardDecisionKey, endCardDecision, hasActionableDevApproval, isCardProtocolText, resetCardDecisions } from "./card-decision";

beforeEach(() => resetCardDecisions());

const approval = (id: string, status: "pending" | "approved" | "rejected"): Message => ({
	id,
	kind: "confirm",
	title: "Executar este comando?",
	status,
	confirmId: id,
	devApproval: { kind: "command", command: "make deploy", cwd: "/workspace" },
});
const user = (id: string, text: string): Message => ({ id, kind: "user", text });

test("cliques de cartão são texto de protocolo (nunca input do run vivo); fala normal não", () => {
	assert.equal(isCardProtocolText("confirmado: Executar este comando?"), true);
	assert.equal(isCardProtocolText("confirmado sempre: Executar este comando?"), true);
	assert.equal(isCardProtocolText("cancela isso"), true);
	assert.equal(isCardProtocolText("Terminou?"), false);
});

test("a decisão de um cartão é enviada uma vez só até o servidor responder", () => {
	const key = cardDecisionKey("conv-1", { id: "msg-1", confirmId: "confirm-r1-abcd1234" });
	assert.equal(beginCardDecision(key), true);
	// toque duplo, remontagem da lista, volta ao app: o mesmo cartão não reenvia
	assert.equal(beginCardDecision(key), false);
	assert.equal(beginCardDecision(cardDecisionKey("conv-1", { id: "outro", confirmId: "confirm-r1-abcd1234" })), false);
	endCardDecision(key);
	assert.equal(beginCardDecision(key), true);
});

test("cartões diferentes (ou conversas diferentes) não se bloqueiam", () => {
	assert.equal(beginCardDecision(cardDecisionKey("conv-1", { id: "a", confirmId: "c1" })), true);
	assert.equal(beginCardDecision(cardDecisionKey("conv-1", { id: "b", confirmId: "c2" })), true);
	assert.equal(beginCardDecision(cardDecisionKey("conv-2", { id: "a", confirmId: "c1" })), true);
});

test("sem cartão pendente não há 'Aguardando sua aprovação'", () => {
	assert.equal(hasActionableDevApproval([user("u1", "oi")]), false);
	assert.equal(hasActionableDevApproval([approval("c1", "approved"), user("u2", "confirmado: x"), approval("c2", "approved")]), false);
	assert.equal(hasActionableDevApproval([approval("c1", "rejected")]), false);
});

test("só o cartão mais recente conta: um antigo preso em pendente não segura o status", () => {
	assert.equal(hasActionableDevApproval([approval("c1", "pending"), user("u1", "Terminou?"), approval("c2", "approved")]), false);
	assert.equal(hasActionableDevApproval([approval("c1", "approved"), approval("c2", "pending")]), true);
});
