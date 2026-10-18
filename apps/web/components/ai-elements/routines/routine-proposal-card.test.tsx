import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Message } from "@/components/ui/templates/template-4/data";
import { RoutineProposalCard } from "./routine-proposal-card";

Object.assign(globalThis, { React });

type Proposal = Extract<Message, { kind: "routine-proposal" }>;
const base: Proposal = {
	id: "m1",
	kind: "routine-proposal",
	proposalId: "p1",
	mode: "suggest",
	status: "pending",
	spec: { name: "Resumo da semana", prompt: "Resuma a minha semana", schedule: "0 8 * * 1", timezone: "America/Sao_Paulo" },
};
const html = (message: Proposal) => renderToStaticMarkup(<RoutineProposalCard message={message} onAccept={() => {}} onDecline={() => {}} />);

test("Sugerir pendente: pergunta com a agenda, Criar primeiro e Agora não à direita, na casca dos pedidos", () => {
	const out = html(base);
	assert.match(out, /data-slot="request-card"[^>]*data-state="pending"/);
	assert.match(out, /Quer que eu faça “Resumo da semana” toda segunda às 8h\?/);
	assert.match(out, /data-tone="pending"[^>]*>Sugestão</);
	assert.ok(out.indexOf(">Criar<") < out.indexOf(">Agora não<"));
	assert.match(out, /ml-auto/);
});

test("Automático pendente: 'Criei a rotina … — manter?' com Manter e Desfazer", () => {
	const out = html({ ...base, mode: "auto", routineId: "r1" });
	assert.match(out, /Criei a rotina “Resumo da semana” — manter\?/);
	assert.ok(out.indexOf(">Manter<") < out.indexOf(">Desfazer<"));
	assert.match(out, /Roda toda segunda às 8h\./);
});

test("decidido: sem botões, só selo e linha de resultado", () => {
	const created = html({ ...base, status: "accepted" });
	assert.match(created, /data-state="resolved"/);
	assert.match(created, />Criada</);
	assert.doesNotMatch(created, />Criar<|>Agora não</);
	const undone = html({ ...base, mode: "auto", status: "declined" });
	assert.match(undone, />Desfeita</);
	assert.match(undone, /A rotina foi removida\./);
	assert.doesNotMatch(undone, />Manter<|>Desfazer</);
});

test("aplicando trava os botões; erro aparece em alerta", () => {
	const out = html({ ...base, isApplying: true, error: "Não consegui concluir. Tente de novo." });
	assert.match(out, /Aplicando…/);
	assert.equal((out.match(/<button[^>]*disabled=""/g) ?? []).length, 2);
	assert.match(out, /role="alert"[^>]*>Não consegui concluir/);
});
