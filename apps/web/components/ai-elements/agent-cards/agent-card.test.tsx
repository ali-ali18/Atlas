import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentV4Event } from "@workspace/shared";

import { I18nProvider } from "@/lib/i18n/provider";
import { loadMessages } from "@/lib/i18n/messages";
import { agentCardMessage } from "@/lib/agent-cards";
import { AgentCard } from "./agent-card";

Object.assign(globalThis, { React });

const render = (card: AgentV4Event, props: Partial<React.ComponentProps<typeof AgentCard>> = {}) =>
	renderToStaticMarkup(<AgentCard message={agentCardMessage(card)} respond={async () => ({})} {...props} />);

const approval: AgentV4Event = {
	type: "approval_request",
	requestId: "req-1",
	callId: "call-1",
	toolName: "send_email",
	effect: "send",
	args: { to: "ana@exemplo.com", subject: "Orçamento de novembro" },
	riskFacts: { recipients: ["ana@exemplo.com"], externalRecipients: ["ana@exemplo.com"], irreversible: true },
	runId: "run-1",
};

test("aprovação: frase simples, Aprovar e 'Agora não', sem nomes internos", () => {
	const html = render(approval);
	assert.match(html, /Enviar para ana@exemplo.com/);
	assert.match(html, />Aprovar</);
	assert.match(html, />Agora não</);
	assert.match(html, /Precisa de você/);
	assert.match(html, /Vai para fora do seu círculo/);
	assert.match(html, /Não dá para desfazer depois/);
	assert.match(html, /Orçamento de novembro/);
	assert.doesNotMatch(html, /send_email|requestId|riskFacts|subject|approval_request/);
	assert.doesNotMatch(html, /agent-card-code-slot/);
});

test("aprovação de pagamento: espaço do código do cartão previsto, sem campo que aceite digitação", () => {
	const html = render({ ...approval, effect: "money", riskFacts: { amount: 89.9, currency: "BRL", merchant: "Livraria" } });
	assert.match(html, /Pagar R\$\s89,90 em Livraria/);
	assert.match(html, /data-slot="agent-card-code-slot"/);
	assert.match(html, /Código de segurança do cartão/);
	assert.match(html, /vai direto para a loja/);
	assert.doesNotMatch(html, /<input/);
});

test("aprovação decidida: só o selo, sem botões", () => {
	const approved = render(approval, { initialDecision: "approved" });
	assert.match(approved, /Aprovado/);
	assert.doesNotMatch(approved, />Aprovar</);
	const dismissed = render(approval, { initialDecision: "dismissed" });
	assert.match(dismissed, /Dispensado/);
	// Resolvido em outro aparelho (a chamada teve resultado): neutro, sem botões.
	const settled = renderToStaticMarkup(<AgentCard message={{ ...agentCardMessage(approval), settled: true }} />);
	assert.match(settled, /Resolvido/);
	assert.doesNotMatch(settled, />Agora não</);
});

test("card sem run não oferece botões (não teria para onde responder)", () => {
	const html = render({ ...approval, runId: undefined });
	assert.doesNotMatch(html, />Aprovar</);
});

test("isso é com você: título, passo a passo numerado, 'Já fiz' e 'Agora não'", () => {
	const html = render({ type: "handoff_request", callId: "c2", message: "1. Abra o app do banco\n2. Aprove o Pix", runId: "run-1" });
	assert.match(html, /Isso é com você/);
	assert.match(html, /<ol[^>]*>.*<li[^>]*>Abra o app do banco<\/li><li[^>]*>Aprove o Pix<\/li><\/ol>/);
	assert.match(html, />Já fiz</);
	assert.match(html, />Agora não</);
});

test("pergunta do bot com alternativas: as duas opções, o campo livre e o selo pendente", () => {
	const html = render({
		type: "ask_owner",
		cardId: "k1",
		question: "Qual capa prefere?",
		choices: [{ value: "comum", label: "Capa comum" }, { value: "dura", label: "Capa dura", description: "R$ 30 a mais" }],
		runId: "run-1",
	});
	assert.match(html, /Pergunta para você/);
	assert.match(html, /Qual capa prefere\?/);
	assert.match(html, /Capa comum/);
	assert.match(html, /Capa dura/);
	assert.match(html, /R\$ 30 a mais/);
	assert.match(html, /Digite sua própria resposta/);
	assert.match(html, /Precisa de você/);
	assert.doesNotMatch(html, /ask_owner|k1/);
});

test("pergunta do bot sem alternativas: só o campo livre", () => {
	const html = render({ type: "ask_owner", cardId: "k1", question: "Prefere azul ou verde?", runId: "run-1" });
	assert.match(html, /Prefere azul ou verde\?/);
	assert.match(html, /Digite sua própria resposta/);
	assert.doesNotMatch(html, /type="radio"|role="radio"/);
});

test("pergunta do bot: respondida e dispensada mostram o estado do questionário", () => {
	const card: AgentV4Event = { type: "ask_owner", cardId: "k1", question: "Prefere azul ou verde?", runId: "run-1" };
	const answered = render(card, { initialDecision: "answered" });
	assert.match(answered, /Respondido/);
	assert.doesNotMatch(answered, /Digite sua própria resposta/);
	const dismissed = render(card, { initialDecision: "dismissed" });
	assert.match(dismissed, /Dispensado/);
	assert.doesNotMatch(dismissed, /Digite sua própria resposta/);
});

test("recibo: linha compacta com o que foi feito, onde e o link; link perigoso não vira âncora", () => {
	const html = render({ type: "receipt", id: "c9", name: "create_event", what: "Evento criado: Reunião", where: "Agenda", url: "https://cal.example.com/e/1", runId: "run-1" });
	assert.match(html, /data-variant="activity"/);
	assert.match(html, /Evento criado: Reunião/);
	assert.match(html, /· Agenda/);
	assert.match(html, /href="https:\/\/cal.example.com\/e\/1"/);
	assert.doesNotMatch(html, /create_event/);
	const unsafe = render({ type: "receipt", id: "c9", name: "x", what: "Feito", url: "javascript:alert(1)" });
	assert.doesNotMatch(unsafe, /href=/);
});

test("cards no idioma da tela", async () => {
	const html = renderToStaticMarkup(
		<I18nProvider locale="en-US" messages={await loadMessages("en-US")}>
			<AgentCard message={agentCardMessage({ type: "handoff_request", callId: "c2", message: "Change your password", runId: "r" })} />
		</I18nProvider>,
	);
	assert.match(html, /This one&#x27;s on you/);
	assert.doesNotMatch(html, /Isso é com você/);
});
