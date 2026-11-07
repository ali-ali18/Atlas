import React from "react";
Object.assign(globalThis, { React });
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgendaAction, AgendaItemView } from "@workspace/shared";
import { AtlasApiError } from "@/lib/atlas-api";
import { performAgendaAction } from "./agenda-actions";
import { AgendaCard } from "./agenda-card";
import { AgendaList } from "./agenda-list";
import { BotAgenda } from "./agenda-section";
import { BotLibrary } from "./bot-library";
import { agendaCardModel } from "./agenda-text";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const TZ = "America/Sao_Paulo";

const item = (patch: Partial<AgendaItemView> = {}): AgendaItemView => ({
	id: "i1",
	botId: "b1",
	kind: "remind",
	status: "pending",
	note: "Ligar para a Dra. Paula",
	nextAt: "2026-11-08T13:00:00.000Z",
	intervalMinutes: null,
	untilAt: null,
	event: null,
	endReason: null,
	runCount: 0,
	maxRuns: null,
	lastUpdate: null,
	createdAt: "2026-11-07T11:00:00.000Z",
	...patch,
});

const render = (items: AgendaItemView[], ended: AgendaItemView[] = [], extra: Partial<React.ComponentProps<typeof AgendaList>> = {}) =>
	renderToStaticMarkup(<AgendaList ended={ended} items={items} now={NOW} onAction={async () => "ok"} timezone={TZ} {...extra} />);

test("renderiza lembrete, acompanhamento e espera por e-mail com frase, estado e próxima vez", () => {
	const html = render([
		item(),
		item({ id: "i2", kind: "watch", note: "Preço do voo para Lisboa", intervalMinutes: 120, untilAt: "2026-11-20T15:00:00.000Z", nextAt: "2026-11-07T14:00:00.000Z", lastUpdate: { outcome: "update", at: "2026-11-07T10:00:00.000Z", message: "Caiu para R$ 3.200." } }),
		item({ id: "i3", kind: "intent", note: "Avisar da nota fiscal", nextAt: null, untilAt: "2026-12-01T15:00:00.000Z", event: { from: "fornecedor@exemplo.com" } }),
		item({ id: "i4", status: "paused", note: "Pagar o boleto" }),
	]);
	assert.match(html, /Pausado: não confiro até você retomar/);
	assert.match(html, /Amanhã às 10:00/);
	assert.match(html, /A cada 2 h até 20\/11/);
	assert.match(html, /Próxima conferência: Hoje às 11:00/);
	assert.match(html, /Novidade há 2 h: Caiu para R\$ 3\.200\./);
	assert.match(html, /Quando chegar e-mail de fornecedor@exemplo\.com/);
	assert.match(html, /Vale até 01\/12/);
	assert.match(html, />Ativo</);
	assert.match(html, />Pausado</);
	assert.match(html, />Lembrete</);
	assert.match(html, />Acompanhando</);
	assert.match(html, />Esperando e-mail</);
});

test("nunca expõe tipo interno nem id", () => {
	const html = render([item({ id: "id-secreto-123", kind: "intent", nextAt: null, event: { from: "a@b.com" } })]);
	assert.doesNotMatch(html, />(watch|intent|remind|brief)</i);
	assert.doesNotMatch(html, /id-secreto-123(?!")/, "o id só pode aparecer no atributo de dados");
	assert.doesNotMatch(html, /agendaKind|eventFilter|ATLAS_ENGINE/);
});

test("pausar/retomar é um interruptor com nome acessível; ativo vem ligado e pausado desligado", () => {
	const html = render([item(), item({ id: "i2", status: "paused", note: "Outro" })]);
	assert.match(html, /aria-label="Pausar: Ligar para a Dra\. Paula"/);
	assert.match(html, /aria-label="Retomar: Outro"/);
	assert.equal((html.match(/role="switch"/g) ?? []).length, 2);
});

test("cancelar: botão com nome acessível, escondido no toque até a pressão longa e só no hover/foco no mouse", () => {
	const hidden = render([item()]);
	const button = hidden.match(/<button[^>]*aria-label="Cancelar: Ligar para a Dra\. Paula"[^>]*>/)?.[0] ?? "";
	assert.ok(button, "botão de cancelar existe");
	assert.match(button, /\[@media\(hover:hover\)\]:opacity-0/);
	assert.match(button, /group-focus-within\/row:opacity-100/);
	assert.match(button, /\[@media\(hover:none\)\]:hidden/, "toque: escondido");
	assert.match(hidden, /data-agenda-card="i1"/, "é a mesma linha apagável do Caderno");
	const revealed = renderToStaticMarkup(<AgendaCard item={item()} model={agendaCardModel(item(), TZ, NOW)} revealed />);
	const shown = revealed.match(/<button[^>]*aria-label="Cancelar: Ligar para a Dra\. Paula"[^>]*>/)?.[0] ?? "";
	assert.doesNotMatch(shown, /\[@media\(hover:none\)\]:hidden/, "pressão longa revela");
});

test("cancelar usa a confirmação na própria linha, sem selo de pendência (estado de saída)", () => {
	const out = renderToStaticMarkup(<AgendaCard confirming item={item()} model={agendaCardModel(item(), TZ, NOW)} />);
	assert.match(out, /Cancelar este combinado\?/);
	assert.doesNotMatch(out, /Precisa de você/);
});

test("a confirmação de cancelar só monta quando pedida (fechada no primeiro desenho)", () => {
	assert.doesNotMatch(render([item()]), /Cancelar este combinado\?/);
});

test("encerrados vêm recolhidos e sem ações, com o motivo em frase", () => {
	const ended = [item({ id: "e1", status: "cancelled", nextAt: null, endReason: "owner", note: "Reunião antiga" }), item({ id: "e2", status: "done", nextAt: null, endReason: "expired", note: "Vigia velho" })];
	const closed = render([item()], ended);
	assert.match(closed, /Encerrados \(2\)/);
	assert.doesNotMatch(closed, /Reunião antiga/, "conteúdo só existe aberto");
	const open = render([item()], ended, { endedOpen: true });
	assert.match(open, /Reunião antiga/);
	assert.match(open, /Você cancelou/);
	assert.match(open, /Chegou ao fim do prazo/);
	assert.match(open, />Encerrado</);
	assert.doesNotMatch(open.slice(open.indexOf("Reunião antiga")), /aria-label="(Pausar|Cancelar)/, "encerrado não tem ação");
});

test("vazio usa o estado vazio com convite em linguagem simples", () => {
	const html = render([]);
	assert.match(html, /data-agenda-empty/);
	assert.match(html, /Nada na agenda/);
	assert.match(html, /me lembra amanhã às 10h/);
});

test("ação chama o cliente com id e ação, e devolve o item novo", async () => {
	const calls: Array<[string, AgendaAction]> = [];
	const paused = item({ status: "paused" });
	const outcome = await performAgendaAction(async (id, action) => (calls.push([id, action]), { item: paused }), { id: "i1" }, "pause");
	assert.deepEqual(calls, [["i1", "pause"]]);
	assert.deepEqual(outcome, { result: "ok", item: paused });
});

test("404 e 409 viram 'gone' (recarrega); outro erro vira 'error'", async () => {
	const failing = (status: number) => async () => {
		throw new AtlasApiError("x", status);
	};
	assert.deepEqual(await performAgendaAction(failing(404), { id: "i1" }, "cancel"), { result: "gone" });
	assert.deepEqual(await performAgendaAction(failing(409), { id: "i1" }, "resume"), { result: "gone" });
	assert.deepEqual(await performAgendaAction(failing(503), { id: "i1" }, "pause"), { result: "error" });
	assert.deepEqual(await performAgendaAction(async () => { throw new Error("rede"); }, { id: "i1" }, "pause"), { result: "error" });
});

test("sem o motor novo a seção não aparece: nem no primeiro desenho nem na Biblioteca", () => {
	assert.equal(renderToStaticMarkup(<BotAgenda active botId="b1" />), "");
	const library = renderToStaticMarkup(<BotLibrary active botId="b1" routines={[]} routinesBody={<p />} />);
	assert.doesNotMatch(library, /data-library-section="agenda"/);
	assert.doesNotMatch(library, />Agenda</);
});
