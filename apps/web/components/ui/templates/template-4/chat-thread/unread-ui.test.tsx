import React from "react";
Object.assign(globalThis, { React });
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NewMessagesDivider } from "./new-messages-divider";
import { ScrollToBottom, newCountLabel } from "./scroll-to-bottom";
import { SourceMarker } from "./source-marker";

test("divisor 'Novas mensagens' é um separador fino e neutro", () => {
	const html = renderToStaticMarkup(<NewMessagesDivider />);
	assert.match(html, /data-testid="new-messages-divider"/);
	assert.match(html, /role="separator"/);
	assert.match(html, /Novas mensagens/);
	assert.match(html, /before:bg-border/);
});

test("marcador de rotina, lembrete e GitHub", () => {
	const routine = renderToStaticMarkup(<SourceMarker source={{ kind: "routine", label: "Resumo da agenda e e-mail", at: "2026-10-30T23:00:00.000Z" }} timeZone="UTC" />);
	assert.match(routine, /Rotina · Resumo da agenda e e-mail · 23:00/);
	assert.match(routine, /data-source-kind="routine"/);
	assert.match(routine, /<svg/);
	const reminder = renderToStaticMarkup(<SourceMarker source={{ kind: "reminder", label: "Pagar a luz", at: "2026-10-30T09:00:00.000Z" }} timeZone="UTC" />);
	assert.match(reminder, /Lembrete · Pagar a luz · 09:00/);
	const github = renderToStaticMarkup(<SourceMarker source={{ kind: "github", label: "push em main", at: "2026-10-30T14:05:00.000Z" }} timeZone="UTC" />);
	assert.match(github, /GitHub · push em main · 14:05/);
	assert.doesNotMatch(`${routine}${reminder}${github}`, /Atlas/);
});

test("pílula '↓ N novas' no botão de ir para o fim", () => {
	assert.equal(newCountLabel(3), "3 novas");
	assert.equal(newCountLabel(1), "1 nova");
	const ref = { current: null };
	const pill = renderToStaticMarkup(<ScrollToBottom newCount={3} targetRef={ref} />);
	assert.match(pill, /3 novas/);
	assert.match(pill, /aria-label="Ir para o fim, 3 novas"/);
	const plain = renderToStaticMarkup(<ScrollToBottom targetRef={ref} />);
	assert.doesNotMatch(plain, /novas/);
	assert.match(plain, /aria-label="Ir para o fim"/);
});
