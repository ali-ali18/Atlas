import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent } from "../data";
import type { BotFollowup } from "@/lib/atlas-api";
import { FollowupDetail, FollowupsSection, ReschedulePicker, followupSubtitle } from "./followups-section";
import { ProactiveSettingsSection } from "./proactive-settings";

Object.assign(globalThis, { React });

const agent = (patch: Partial<Agent> & { policyJson?: unknown } = {}): Agent => ({ id: "b1", name: "Principal", snippet: "", color: "#f44336", ...patch }) as Agent;
const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const render = (a: Agent, accountTimezone?: string) =>
	html(<ProactiveSettingsSection accountTimezone={accountTimezone} agent={a} onChange={() => {}} />);

test("bot que não é o principal: não há nada de modo proativo para mostrar", () => {
	const out = render(agent({ isPrimary: false, policyJson: { proactive: { enabled: true } } }));
	assert.equal(out, "");
});

test("principal com o modo desligado: só o interruptor, sem opções", () => {
	const out = render(agent({ isPrimary: true }));
	assert.match(out, /Modo proativo/);
	assert.match(out, /Cria lembretes e sugere rotinas sozinho\. Só fala no chat\./);
	assert.match(out, /role="switch"[^>]*aria-checked="false"|aria-checked="false"[^>]*role="switch"/);
	assert.doesNotMatch(out, /data-proactive-options/);
});

test("principal com o modo ligado: Rotinas (Sugerir por padrão), máx. por dia (3), silêncio 22:00-08:00 e fuso", () => {
	const out = render(agent({ isPrimary: true, policyJson: { proactive: { enabled: true, timezone: "America/Sao_Paulo" } } }));
	assert.match(out, /data-proactive-options/);
	assert.match(out, /aria-checked="true"/);
	assert.match(out, />Rotinas</);
	assert.match(out, />Sugerir</);
	assert.match(out, /O bot mostra um card e você escolhe criar a rotina\./);
	assert.match(out, /Máx\. mensagens proativas por dia/);
	assert.match(out, />3</);
	assert.match(out, /Horário de silêncio/);
	assert.match(out, /type="time"[^>]*value="22:00"/);
	assert.match(out, /type="time"[^>]*value="08:00"/);
	assert.match(out, />Fuso horário</);
	assert.match(out, /São Paulo \(GMT-3\)/);
	assert.match(out, /Do navegador, ao ligar\./);
});

test("fuso da conta manda sobre o do bot e a tela diz de onde vem", () => {
	const out = render(
		agent({ isPrimary: true, policyJson: { proactive: { enabled: true, timezone: "America/Sao_Paulo" } } }),
		"Europe/Lisbon",
	);
	assert.match(out, /Lisbon \(GMT[^)]*\)/);
	assert.match(out, /Das configurações da conta\./);
});

test("modo Automático e limites escolhidos aparecem", () => {
	const out = render(agent({ isPrimary: true, policyJson: { proactive: { enabled: true, routineMode: "auto", maxPerDay: 6, quietStart: "23:00", quietEnd: "07:30" } } }));
	assert.match(out, />Automático</);
	assert.match(out, /O bot cria a rotina e avisa; você pode desfazer\./);
	assert.match(out, />6</);
	assert.match(out, /value="23:00"/);
	assert.match(out, /value="07:30"/);
});

test("lembretes agendados: lista com horário no fuso, tipo e origem; vazio e carregando", () => {
	const items = [
		{ id: "f1", note: "Entregar o relatório ao João", kind: "reminder" as const, dueAt: "2026-10-14T12:00:00.000Z", source: "chat" as const },
		{ id: "f2", note: "Ver o resultado da licitação", kind: "check" as const, dueAt: "2026-10-16T17:30:00.000Z", source: "reflection" as const },
	];
	const out = html(<FollowupsSection followups={items} loaded onCancel={async () => true} timeZone="America/Sao_Paulo" />);
	assert.match(out, />Lembretes agendados</);
	assert.match(out, /Entregar o relatório ao João/);
	assert.match(out, /14\/10 às 09:00 · Lembrete</);
	assert.match(out, /16\/10 às 14:30 · Verificação · ideia do bot</);
	assert.match(out, /aria-label="Cancelar lembrete: Entregar o relatório ao João"/);
	assert.match(html(<FollowupsSection followups={[]} loaded onCancel={async () => true} timeZone="America/Sao_Paulo" />), /Nenhum lembrete agendado/);
	assert.match(html(<FollowupsSection followups={[]} loaded={false} onCancel={async () => true} timeZone="America/Sao_Paulo" />), /Carregando…/);
	assert.equal(followupSubtitle({ kind: "check", source: "chat" }, "x"), "x · Verificação");
});

test("lembrete: lista mostra botao de abrir; detalhe com nota completa, linhas e cancelar", () => {
	const item = { id: "f1", note: "Linha um\nLinha dois", kind: "check" as const, dueAt: "2026-10-16T17:30:00.000Z", source: "reflection" as const };
	const list = html(<FollowupsSection followups={[item]} loaded onCancel={async () => true} onOpen={() => {}} timeZone="America/Sao_Paulo" />);
	assert.match(list, /aria-label="Abrir lembrete: Linha um/);
	assert.match(list, /line-clamp-2/);
	assert.doesNotMatch(list, /Dispara/);
	const detail = (i: BotFollowup) => html(<FollowupDetail item={i} onCancel={async () => true} onDone={() => {}} timeZone="America/Sao_Paulo" />);
	const out = detail(item);
	assert.match(out, /whitespace-pre-wrap[^>]*>Linha um\nLinha dois</);
	assert.match(out, />Dispara<[\s\S]*16\/10 às 14:30/);
	assert.match(out, />Tipo<[\s\S]*Verificação/);
	assert.match(out, />Origem<[\s\S]*Ideia do bot/);
	assert.match(out, />Cancelar lembrete</);
	assert.match(detail({ ...item, source: "chat", kind: "reminder" }), /Você pediu/);
});

test("reagendar: botão secundário acima de Cancelar; sem a função, nada aparece", () => {
	const item: BotFollowup = { id: "f1", note: "Entregar o relatório", kind: "reminder", dueAt: "2026-10-30T12:00:00.000Z", source: "chat" };
	const withReschedule = html(
		<FollowupDetail item={item} onCancel={async () => true} onDone={() => {}} onReschedule={async () => ({ ok: true, movedForQuietHours: false })} timeZone="America/Sao_Paulo" />,
	);
	assert.match(withReschedule, /bg-secondary[^>]*>[\s\S]*Reagendar<[\s\S]*Cancelar lembrete</);
	assert.doesNotMatch(withReschedule, /data-reschedule-picker/);
	const without = html(<FollowupDetail item={item} onCancel={async () => true} onDone={() => {}} timeZone="America/Sao_Paulo" />);
	assert.doesNotMatch(without, /Reagendar/);
});

test("seletor: atalhos no fuso da conta, campo datetime-local com mínimo e Salvar travado sem horário", () => {
	// Quarta 2026-10-14, 10:00 em São Paulo.
	const now = new Date("2026-10-14T13:00:00.000Z");
	const open = (initialValue?: string) =>
		html(<ReschedulePicker busy={false} error={null} initialValue={initialValue} now={now} onBack={() => {}} onSave={() => {}} timeZone="America/Sao_Paulo" />);
	const empty = open();
	assert.match(empty, />Amanhã 9h</);
	assert.match(empty, />Em 3 dias</);
	assert.match(empty, />Próxima segunda 9h</);
	assert.match(empty, /type="datetime-local"/);
	assert.match(empty, /min="2026-10-14T10:00"/);
	assert.match(empty, /dark:\[color-scheme:dark\]/);
	assert.match(empty, /<button[^>]* disabled=""[^>]*>Salvar</);
	const picked = open("2026-10-15T09:00");
	assert.match(picked, /value="2026-10-15T09:00"/);
	assert.match(picked, /aria-pressed="true"[^>]*data-quick="tomorrow"/);
	assert.doesNotMatch(picked, /<button[^>]* disabled=""[^>]*>Salvar</);
	assert.match(open("2026-10-10T09:00"), /<button[^>]* disabled=""[^>]*>Salvar</);
});

test("seletor: mostra o erro do servidor", () => {
	const out = html(
		<ReschedulePicker busy={false} error="esse horário já passou; informe um momento futuro" now={new Date()} onBack={() => {}} onSave={() => {}} timeZone="America/Sao_Paulo" />,
	);
	assert.match(out, /role="alert"[^>]*>esse horário já passou/);
});

test("lembrete com vários avisos: card mostra o próximo aviso e a posição; detalhe lista os avisos", () => {
	const item: BotFollowup = {
		id: "f1",
		note: "Entrega do relatório trimestral",
		kind: "reminder",
		dueAt: "2026-10-30T12:00:00.000Z",
		source: "chat",
		stages: [
			{ at: "2026-10-15T12:00:00.000Z", firedAt: "2026-10-15T12:01:00.000Z" },
			{ at: "2026-10-30T12:00:00.000Z", firedAt: null },
			{ at: "2026-11-06T12:00:00.000Z", firedAt: null },
			{ at: "2026-11-11T12:00:00.000Z", firedAt: null },
		],
	};
	const list = html(<FollowupsSection followups={[item]} loaded onCancel={async () => true} onOpen={() => {}} timeZone="America/Sao_Paulo" />);
	assert.match(list, /Próximo aviso: sex, 30\/10 às 09:00 · 2 de 4</);
	assert.equal((list.match(/data-followup=/g) ?? []).length, 1);
	assert.equal(followupSubtitle({ kind: "reminder", source: "reflection", stages: item.stages }, "x"), "Próximo aviso: x · 2 de 4 · ideia do bot");
	const detail = html(<FollowupDetail item={item} onCancel={async () => true} onDone={() => {}} onReschedule={async () => ({ ok: true, movedForQuietHours: false })} timeZone="America/Sao_Paulo" />);
	assert.match(detail, />Avisos</);
	assert.match(detail, />1º aviso<[\s\S]*data-stage="done"[\s\S]*Enviado/);
	assert.match(detail, /data-stage="next"[\s\S]*Próximo</);
	assert.equal((detail.match(/data-stage="pending"/g) ?? []).length, 2);
	assert.equal((detail.match(/aria-label="Reagendar \dº aviso"/g) ?? []).length, 3);
	assert.doesNotMatch(detail, />Dispara</);
	assert.match(detail, />Reagendar próximo aviso</);
	assert.match(detail, />Cancelar lembrete</);
});

test("lembrete antigo sem stages continua com Dispara e subtítulo simples", () => {
	const item: BotFollowup = { id: "f1", note: "Antigo", kind: "reminder", dueAt: "2026-10-30T12:00:00.000Z", source: "chat" };
	assert.match(html(<FollowupDetail item={item} onCancel={async () => true} onDone={() => {}} timeZone="America/Sao_Paulo" />), />Dispara</);
	assert.doesNotMatch(html(<FollowupsSection followups={[item]} loaded onCancel={async () => true} timeZone="America/Sao_Paulo" />), /Próximo aviso/);
});

test("seletor com título do aviso", () => {
	const out = html(<ReschedulePicker busy={false} error={null} now={new Date("2026-10-14T13:00:00.000Z")} onBack={() => {}} onSave={() => {}} timeZone="America/Sao_Paulo" title="Aviso 3 de 4" />);
	assert.match(out, />Aviso 3 de 4</);
});
