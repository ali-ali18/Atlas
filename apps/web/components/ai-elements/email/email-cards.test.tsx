import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EmailTriageEntry } from "@workspace/shared";

import { loadMessages } from "@/lib/i18n/messages";
import type { UiLocale } from "@/lib/i18n/locales";
import { I18nProvider } from "@/lib/i18n/provider";

import { EmailDraftCard, EmailTriageCard } from "./index";

Object.assign(globalThis, { React });

async function render(node: React.ReactNode, locale: UiLocale = "pt-BR") {
	return renderToStaticMarkup(<I18nProvider locale={locale} messages={await loadMessages(locale)}>{node}</I18nProvider>);
}

const items: EmailTriageEntry[] = [
	{ id: "m3", category: "ignore", summary: "Promoção de fim de ano", subject: "Black Friday" },
	{ id: "m2", category: "fyi", summary: "Relatório mensal publicado", subject: "Relatório", from: "ops@empresa.test" },
	{ id: "m1", category: "needs_action", summary: "Aprovar o orçamento", subject: "Orçamento", requester: "Ana Souza", deadline: "2026-11-12" },
];

test("triagem: grupos na ordem, contagem no selo, prazo sem deslocar o dia e quem pede", async () => {
	const html = await render(<EmailTriageCard items={items} />);
	assert.match(html, /data-testid="email-triage-card"/);
	assert.match(html, /1 precisa de ação/);
	assert.ok(html.indexOf("Precisa de ação") < html.indexOf("Só para saber") && html.indexOf("Só para saber") < html.indexOf("Pode ignorar"));
	assert.match(html, /Prazo: 12 de nov\.?/);
	assert.match(html, /Pedido por Ana Souza/);
	assert.match(html, /De ops@empresa\.test/);
	assert.match(html, /Ver tudo \(1\)/);
});

test("triagem: sem nada que peça ação o selo diz isso; en-US e es-ES traduzidos", async () => {
	assert.match(await render(<EmailTriageCard items={[items[1]!]} />), /Nada pede ação/);
	assert.match(await render(<EmailTriageCard items={items} />, "en-US"), /1 needs action[\s\S]*Due: Nov 12/);
	assert.match(await render(<EmailTriageCard items={items} />, "es-ES"), /1 requiere acción[\s\S]*Plazo: 12 nov/);
});

test("triagem: texto do e-mail aparece como texto (sem HTML)", async () => {
	const html = await render(<EmailTriageCard items={[{ id: "x", category: "fyi", summary: "<img src=x onerror=alert(1)>" }]} />);
	assert.doesNotMatch(html, /<img/);
	assert.match(html, /&lt;img/);
});

test("rascunho: destinatários, assunto, texto, selo 'Não enviado' e onde ficou guardado; sem botão de enviar", async () => {
	const html = await render(<EmailDraftCard body="Olá Ana, aprovado." cc={["b@y.test"]} reply saved source="gmail" subject="Re: Orçamento" to={["ana@empresa.test"]} />);
	assert.match(html, /data-testid="email-draft-card"/);
	assert.match(html, /Rascunho de resposta/);
	assert.match(html, /Não enviado/);
	assert.match(html, /ana@empresa\.test/);
	assert.match(html, /Cópia/);
	assert.match(html, /Guardado nos rascunhos do seu Gmail\. Nada foi enviado\./);
	assert.doesNotMatch(html, /<button/);
	const onlyHere = await render(<EmailDraftCard body="Texto" saved={false} source="bot" subject="Preço" to={["c@fora.test"]} />);
	assert.match(onlyHere, /Só existe aqui na conversa/);
	assert.match(onlyHere, /Rascunho de e-mail/);
});

test("rascunho: texto longo fica atrás de "Ler o texto" (aberto, mostra tudo: conferido nas prévias)", async () => {
	const body = "palavra ".repeat(200);
	const html = await render(<EmailDraftCard body={body} saved source="gmail" subject="s" to={["a@b.test"]} />);
	assert.match(html, /Ler o texto/);
	assert.doesNotMatch(html, /data-testid="email-draft-body"/);
});
