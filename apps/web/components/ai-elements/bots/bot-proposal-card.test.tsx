import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BotProposalData } from "@workspace/shared";
import { BotProposalCard, type BotProposalCardProps } from "./bot-proposal-card";

Object.assign(globalThis, { React });

const proposal: BotProposalData = {
	proposalId: "bot-run-1",
	status: "pending",
	name: "Estoquinho",
	description: "Acompanha o estoque e avisa quando um item está acabando.",
	snippet: "Avisa quando algo acaba",
	color: "#1084FE",
	shape: "hex",
	model: "anthropic/claude-sonnet-4.5",
	skills: ["resumo-semanal"],
	firstTask: "Liste os itens com estoque abaixo de 5.<script>alert(1)</script>",
};

function render(props: Partial<BotProposalCardProps> = {}) {
	return renderToStaticMarkup(<BotProposalCard proposal={proposal} {...props} />);
}

test("pendente: avatar, nome, papel, modelo, skills e os três botões", () => {
	const html = render();
	assert.match(html, /data-kind="bot-proposal"/);
	assert.match(html, /Criar o agente “Estoquinho”\?/);
	assert.match(html, /Novo agente/);
	assert.match(html, /<svg/);
	assert.match(html, /Acompanha o estoque/);
	assert.match(html, /claude-sonnet-4\.5/);
	assert.match(html, />resumo-semanal</);
	assert.match(html, />Criar agente</);
	assert.match(html, />Editar</);
	assert.match(html, />Agora não</);
});

test("sem modelo escolhido mostra o padrão e a primeira tarefa sai escapada", () => {
	const html = render({ proposal: { ...proposal, model: null } });
	assert.match(html, />Modelo padrão</);
	assert.match(html, /Primeira tarefa: /);
	assert.doesNotMatch(html, /<script>/);
});

test("aplicando trava os botões e troca o rótulo", () => {
	const html = render({ isApplying: true });
	assert.match(html, />Criando…</);
	assert.equal((html.match(/disabled=""/g) ?? []).length >= 3, true);
});

test("editar abre nome e papel com os valores atuais", () => {
	const html = render({ defaultEditing: true });
	assert.match(html, /aria-label="Nome do agente"[^>]*value="Estoquinho"|value="Estoquinho"[^>]*aria-label="Nome do agente"/);
	assert.match(html, /aria-label="O que o agente faz"/);
	assert.match(html, />Pronto</);
});

test("criado: selo, confirmação e sem botões de decisão", () => {
	const html = render({ proposal: { ...proposal, status: "approved", botId: "bot-9" } });
	assert.match(html, /Agente criado: “Estoquinho”/);
	assert.match(html, />Criado</);
	assert.match(html, /Primeira tarefa enviada\./);
	assert.doesNotMatch(html, />Criar agente</);
	assert.doesNotMatch(html, />Agora não</);
});

test("dispensado: selo discreto e sem ações", () => {
	const html = render({ proposal: { ...proposal, status: "rejected" } });
	assert.match(html, /Proposta dispensada/);
	assert.doesNotMatch(html, />Criar agente</);
});

test("erro aparece no card", () => {
	assert.match(render({ error: "Não consegui criar o agente. Tente de novo." }), /role="alert"[^>]*>Não consegui criar o agente/);
});
