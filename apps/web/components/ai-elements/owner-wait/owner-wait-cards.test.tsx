import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LoginCard } from "@/components/ai-elements/login";
import { QuestionnaireCard } from "@/components/ui/templates/template-4/chat-thread/questionnaire-card";
import { OwnerApprovalCard, ReturnMarker, StepLimitCard } from ".";

Object.assign(globalThis, { React });

const now = new Date("2026-11-04T12:00:00.000Z");
const tz = "America/Sao_Paulo";
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);

test("Computador (v3): rótulo, \"Ação necessária\", instrução do site, prévia da tela, Pular · Terminei · Assumir e a nota fora do card", () => {
	const html = renderToStaticMarkup(<LoginCard deadlineAt="2026-11-04T17:30:00.000Z" now={now} ownerWait screenshotUrl="/v1/sandbox/sessions/s1/screenshot?v=l1" site="gemini.google.com" timeZone={tz} />);
	assert.match(html, /data-slot="chat-card-label"[^>]*>Computador</);
	assert.match(html, /data-slot="chat-card-title"[^>]*>Ação necessária</);
	assert.match(html, /Entre na sua conta de gemini\.google\.com e depois devolva a tela/);
	assert.match(html, /data-slot="handoff-preview"[^>]*>.*src="\/v1\/sandbox\/sessions\/s1\/screenshot\?v=l1"/);
	// Pílulas da esquerda para a direita; Assumir, a principal clara, na ponta.
	assert.deepEqual(buttons(html).filter((label) => label !== ""), ["Pular", "Terminei", "Assumir"]);
	assert.match(html, /bg-foreground text-background[^>]*>Assumir</);
	assert.match(html, /Sigo sem isso às 14:30/);
	assert.match(html, /data-slot="handoff-note"[^>]*>.*Se você entrar, faz isso no navegador do computador do bot/);
	assert.doesNotMatch(html, />[^<]*(waitMinutes|deadlineAt|cron|\d+ ?min)[^<]*</);
});

test("Computador sem captura da tela: oferece abrir o computador no lugar da prévia", () => {
	const html = renderToStaticMarkup(<LoginCard ownerWait site="gemini.google.com" />);
	assert.doesNotMatch(html, /handoff-preview/);
	assert.match(html, /Abrir o computador/);
});

test("login do v3 decidido: só o selo da saída, sem botões", () => {
	for (const [outcome, label] of [["takeover", "Você assumiu"], ["skipped_timeout", "Tempo esgotado · segui sem isso"], ["ignored", "Dispensado"], ["skipped", "Pulado · segui sem isso"]] as const) {
		const html = renderToStaticMarkup(<LoginCard outcome={outcome} ownerWait site="gemini.google.com" status="done" />);
		assert.match(html, new RegExp(label));
		assert.match(html, new RegExp(`data-login-outcome="${outcome}"`));
		assert.equal(buttons(html).length, 0, outcome);
	}
});

test("login do v1/v2 (sem ownerWait) continua com Abrir a VM e Terminei, sem Pular nem Assumir", () => {
	const html = renderToStaticMarkup(<LoginCard site="portal.exemplo.com" />);
	assert.doesNotMatch(html, /Pular|Assumir/);
	assert.match(html, /Terminei/);
});

test("aprovação do v3: Permitir · Agora não, args legíveis e prazo; rascunho explica que a rotina preparou", () => {
	const approval = renderToStaticMarkup(<OwnerApprovalCard deadlineAt="2026-11-04T17:30:00.000Z" description={"to: ana@cliente.com\nsubject: Vendas"} now={now} timeZone={tz} title="Enviar esta mensagem?" variant="approval" />);
	assert.deepEqual(buttons(approval), ["Agora não", "Permitir"]);
	assert.match(approval, /<dt[^>]*>Para<\/dt><dd[^>]*>ana@cliente.com<\/dd>/);
	assert.match(approval, /Sigo sem isso às 14:30/);
	assert.doesNotMatch(approval, /to:|subject:/);
	const draft = renderToStaticMarkup(<OwnerApprovalCard description={"Resumo de outubro para a Ana.\n\nto: ana@cliente.com"} title="Enviar esta mensagem?" variant="draft" />);
	assert.match(draft, /A rotina preparou isto/);
	assert.match(draft, /Rascunho da rotina/);
	assert.match(draft, /Resumo de outubro para a Ana\./);
	assert.match(draft, /data-owner-card="draft"/);
});

test("cartão do limite: resumo do que foi feito, Continuar · Agora não; decidido vira selo", () => {
	const html = renderToStaticMarkup(
		<StepLimitCard description="Guardei onde parei." progress={{ steps: 40, costUsd: 0.12, tasksDone: ["Ler as notas", "Montar a planilha"], tasksTotal: 4 }} status="pending" title="Cheguei no limite de 40 passos. Continuo?" />,
	);
	assert.deepEqual(buttons(html), ["Agora não", "Continuar"]);
	assert.match(html, /Fiz 40 passos · gastei US\$\s?0,12 · 2 de 4 tarefas concluídas/);
	assert.match(html, /Montar a planilha/);
	const done = renderToStaticMarkup(<StepLimitCard status="approved" title="Cheguei no limite de 40 passos. Continuo?" />);
	assert.match(done, /Continuei/);
	assert.equal(buttons(done).length, 0);
	assert.match(renderToStaticMarkup(<StepLimitCard status="rejected" title="x" />), /Parei aqui/);
});

test("Volto às: pendente com Cancelar (aria-label com a hora); cancelado e concluído sem botão", () => {
	const pending = renderToStaticMarkup(<ReturnMarker at="2026-11-04T17:30:00.000Z" now={now} onCancel={() => undefined} status="pending" timeZone={tz} />);
	assert.match(pending, /Volto às 14:30/);
	assert.match(pending, /aria-label="Cancelar o retorno de 14:30"/);
	const cancelled = renderToStaticMarkup(<ReturnMarker at="2026-11-04T17:30:00.000Z" now={now} onCancel={() => undefined} status="cancelled" timeZone={tz} />);
	assert.match(cancelled, /Cancelado/);
	assert.equal(buttons(cancelled).length, 0);
	assert.match(renderToStaticMarkup(<ReturnMarker at="2026-11-04T17:30:00.000Z" now={now} status="done" timeZone={tz} />), /Voltei/);
});

test("questionário do v3 tem Pular (e o prazo); o do v1/v2 segue com o X de dispensar", () => {
	const base = { id: "q1", kind: "questionnaire" as const, questionnaireId: "questionnaire-r1", title: "Qual período?", status: "pending" as const, items: [{ name: "p", prompt: "Qual período?", choices: [{ value: "mes", label: "Último mês" }] }] };
	const v3 = renderToStaticMarkup(<QuestionnaireCard message={{ ...base, ownerWait: true, deadlineAt: "2026-11-04T17:30:00.000Z" }} now={now} onDismiss={() => undefined} onSkip={() => undefined} timeZone={tz} />);
	assert.match(v3, /data-questionnaire-close="skip"/);
	assert.match(v3, /aria-label="Pular o questionário"/);
	assert.match(v3, /Sigo sem isso às 14:30/);
	const legacy = renderToStaticMarkup(<QuestionnaireCard message={base} onDismiss={() => undefined} onSkip={() => undefined} />);
	assert.match(legacy, /data-questionnaire-close="dismiss"/);
	assert.match(legacy, /aria-label="Dispensar questionário"/);
});
