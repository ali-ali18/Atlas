import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Message } from "../data";
import { MessageRow } from "./message-row";

Object.assign(globalThis, { React });

const plan = {
	title: "Criar propostas dos pedidos",
	steps: [
		{ text: "Listar pedidos abertos", kind: "read" as const },
		{ text: "Criar a proposta de cada pedido", kind: "write" as const },
	],
	needs: ["Forma de pagamento"],
	risks: "A proposta criada não se desfaz",
};
const card = (patch: Partial<Extract<Message, { kind: "confirm" }>> = {}): Message => ({
	id: "plan-1",
	kind: "confirm",
	title: plan.title,
	status: "pending",
	confirmId: "confirm-plan-r1",
	confirmLabel: "Aprovar plano",
	cancelLabel: "Cancelar",
	plan,
	...patch,
});

test("cartão de confirmação com plano vira o cartão do plano, com Aprovar plano, Ajustar e Cancelar", () => {
	const html = renderToStaticMarkup(<MessageRow message={card()} onAdjustPlan={() => undefined} onCancel={() => undefined} onConfirm={() => undefined} />);
	assert.match(html, /data-plan-card/);
	assert.match(html, /Criar propostas dos pedidos/);
	assert.match(html, /Aprovar plano/);
	assert.match(html, /aria-label="Ajustar"/);
	assert.match(html, /aria-label="Cancelar"/);
	assert.match(html, /Preciso de/);
	assert.match(html, /não aprova as ações/);
	assert.doesNotMatch(html, /Precisa de aprovação/);
});

test("decidido: aprovado, ajuste pedido (recusado com o desfecho) e cancelado", () => {
	const state = (message: Message) => /data-plan-status="([a-z]+)"/.exec(renderToStaticMarkup(<MessageRow message={message} />))?.[1];
	assert.equal(state(card({ status: "approved" })), "approved");
	assert.equal(state(card({ status: "rejected", planOutcome: "ajuste pedido" })), "adjusted");
	assert.equal(state(card({ status: "rejected", planOutcome: "plano cancelado" })), "cancelled");
	assert.equal(state(card({ status: "rejected" })), "cancelled");
});

test("sem plano, o cartão de confirmação segue sendo o de sempre", () => {
	const html = renderToStaticMarkup(<MessageRow message={card({ plan: undefined, confirmLabel: "Executar" })} onConfirm={() => undefined} />);
	assert.doesNotMatch(html, /data-plan-card/);
	assert.match(html, /Executar/);
});
