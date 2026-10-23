import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { routineCardSummary } from "@/components/ui/templates/template-4/chat-context-panel/routine-map";
import { RoutineActivityCard } from "./routine-activity";

Object.assign(globalThis, { React });

const cronDetail = "Cron: 0 8 * * 1 (America/Sao_Paulo)\nAtiva: sim\n\nRebuild the page.";

test("routineCardSummary: cron vira o resumo do painel; intervalo e uma vez usam a 1ª linha; webhook, nada", () => {
	assert.equal(routineCardSummary("cron", cronDetail), "A cada segunda-feira às 8:00");
	assert.equal(routineCardSummary("cron", "Cron: 0 9 * * * (America/Sao_Paulo)"), "Todos os dias às 9:00");
	assert.equal(routineCardSummary("interval", "A cada 50 min\nRepete no intervalo."), "A cada 50 min");
	assert.equal(routineCardSummary("once", "Uma vez · 03/10 às 10:00\nDispara uma vez."), "Uma vez · 03/10 às 10:00");
	assert.equal(routineCardSummary("event", "Webhook: https://x.test/v1/hooks/k"), null);
	assert.equal(routineCardSummary("cron", "texto qualquer"), null);
	assert.equal(routineCardSummary("cron", undefined), null);
});

test("cartão de rotina criada mostra 'Rotina criada · agendamento' abaixo do nome", () => {
	const html = renderToStaticMarkup(<RoutineActivityCard action="created" detail={cronDetail} routineId="r1" title="Painel semanal" triggerType="cron" />);
	assert.match(html, />Painel semanal</);
	assert.match(html, /data-routine-summary[^>]*>Rotina criada · A cada segunda-feira às 8:00</);
});

test("sem agendamento reconhecível (ou ação que não é criação) o cartão fica como antes", () => {
	const webhook = renderToStaticMarkup(<RoutineActivityCard action="created" detail="Webhook: https://x.test" routineId="r1" title="Hook" triggerType="event" />);
	assert.doesNotMatch(webhook, /data-routine-summary/);
	const updated = renderToStaticMarkup(<RoutineActivityCard action="updated" detail={cronDetail} routineId="r1" title="Painel" triggerType="cron" />);
	assert.doesNotMatch(updated, /data-routine-summary/);
});

test("cartão de rotina de e-mail mostra a frase do gatilho e o ícone de e-mail (não o de webhook)", () => {
	const detail = "Quando chegar e-mail de fornecedor@ com 'NF' no assunto\n\nRegistre a NF.";
	const email = renderToStaticMarkup(<RoutineActivityCard action="created" detail={detail} routineId="r1" title="NF" triggerType="event" />);
	assert.match(email, /data-routine-summary[^>]*>Rotina criada · Quando chegar e-mail de fornecedor@ com &#x27;NF&#x27; no assunto</);
	assert.match(email, /lucide-mail/);
	assert.doesNotMatch(email, /lucide-webhook/);
	const webhook = renderToStaticMarkup(<RoutineActivityCard action="created" detail="Webhook: https://x.test" routineId="r1" title="Hook" triggerType="event" />);
	assert.match(webhook, /lucide-webhook/);
});
