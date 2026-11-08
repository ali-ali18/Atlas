import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { loadMessages } from "@/lib/i18n/messages";
import type { UiLocale } from "@/lib/i18n/locales";
import { I18nProvider } from "@/lib/i18n/provider";

import { CalendarCard, DayPlanCard } from "./index";

Object.assign(globalThis, { React });

async function render(node: React.ReactNode, locale: UiLocale = "pt-BR") {
	return renderToStaticMarkup(<I18nProvider locale={locale} messages={await loadMessages(locale)}>{node}</I18nProvider>);
}

const event = { id: "e1", title: "Reunião de produto", start: "2026-11-10T17:00:00.000Z", end: "2026-11-10T18:00:00.000Z", allDay: false, location: "Sala 2", attendeeCount: 2, link: "https://www.google.com/calendar/event?eid=1" };
const TZ = "America/Sao_Paulo";

test("evento criado: horário no fuso do dono, local, convidados, convite enviado, conflito e link seguro", async () => {
	const html = await render(<CalendarCard action="created" events={[{ ...event, conflict: true }]} notified timeZone={TZ} />);
	assert.match(html, /data-testid="calendar-card"/);
	assert.match(html, /Evento criado/);
	assert.match(html, /14:00–15:00/);
	assert.match(html, /Sala 2 · 2 convidados/);
	assert.match(html, /Bate com outro compromisso/);
	assert.match(html, /Convite enviado aos convidados/);
	assert.match(html, /href="https:\/\/www\.google\.com\/calendar\/event\?eid=1"[^>]*rel="noopener noreferrer"|rel="noopener noreferrer"[^>]*href="https:\/\/www\.google\.com/);
});

test("link inseguro nunca vira href; lista vazia diz que o período está livre; dia inteiro não tem hora", async () => {
	const bad = await render(<CalendarCard action="updated" events={[{ ...event, link: "javascript:alert(1)" }]} timeZone={TZ} />);
	assert.doesNotMatch(bad, /javascript:/);
	const empty = await render(<CalendarCard action="listed" events={[]} timeZone={TZ} />);
	assert.match(empty, /Nada marcado neste período\./);
	const allDay = await render(<CalendarCard action="listed" events={[{ id: "f", title: "Feriado", start: "2026-11-15", end: "2026-11-16", allDay: true }]} timeZone={TZ} />);
	assert.match(allDay, /O dia todo/);
	assert.match(allDay, /Feriado/);
});

test("em en-US e es-ES o cartão está traduzido", async () => {
	assert.match(await render(<CalendarCard action="created" events={[event]} timeZone={TZ} />, "en-US"), /Event created[\s\S]*2 guests/);
	assert.match(await render(<CalendarCard action="listed" events={[]} timeZone={TZ} />, "es-ES"), /Nada programado en este período\./);
});

const plan = { date: "2026-11-10", timeZone: TZ, headline: "Hoje: 2 compromissos e 1 e-mail pede ação.", sourceErrors: [] };

test("Plano do dia completo: frase, as quatro seções na ordem, hora do compromisso e detalhe", async () => {
	const html = await render(
		<DayPlanCard
			{...plan}
			sections={[
				{ id: "commitments", items: [{ text: "Reunião de produto", time: "14:00" }, { text: "Dentista", time: "16:30", detail: "Leve o convênio" }] },
				{ id: "emails", items: [{ text: "Contador pede o recibo", detail: "prazo sexta" }] },
				{ id: "pending", items: [{ text: "Enviar o relatório" }] },
				{ id: "deliveries", items: [{ text: "Fone X chega hoje" }] },
			]}
		/>,
	);
	assert.match(html, /data-testid="day-plan-card"/);
	assert.match(html, /Plano do dia/);
	assert.match(html, /terça-feira, 10 de novembro/);
	assert.match(html, /Hoje: 2 compromissos e 1 e-mail pede ação\./);
	const order = ["Compromissos", "E-mails que pedem ação", "Pendências", "Entregas"].map((label) => html.indexOf(label));
	assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!)), `ordem das seções: ${order.join(",")}`);
	assert.match(html, /14:00/);
	assert.match(html, /Leve o convênio/);
	assert.doesNotMatch(html, /day-plan-errors/);
});

test("seção vazia some e fonte com falha vira UMA linha honesta (e pede reconectar quando o login expirou)", async () => {
	const html = await render(<DayPlanCard {...plan} sections={[{ id: "emails", items: [{ text: "Contador pede o recibo" }] }]} sourceErrors={[{ source: "calendar", reason: "failed" }, { source: "email", reason: "needs_connection" }]} />);
	assert.doesNotMatch(html, /Compromissos/);
	assert.doesNotMatch(html, /Pendências/);
	assert.match(html, /Não consegui ler a agenda\./);
	assert.match(html, /Reconecte o e-mail para eu ler suas mensagens\./);
	assert.match(await render(<DayPlanCard {...plan} sections={[]} sourceErrors={[{ source: "calendar", reason: "failed" }]} />, "en-US"), /I couldn&#x27;t read your calendar\./);
	assert.match(await render(<DayPlanCard {...plan} sections={[]} sourceErrors={[{ source: "calendar", reason: "failed" }]} />, "es-ES"), /No pude leer tu agenda\./);
});
