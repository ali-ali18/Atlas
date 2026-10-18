import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { FIXTURE_SESSION_ID, devSessionFixtureEvents } from "@/lib/dev-session/fixture";
import { applyContextCompacted, applyContextUsage, applyDevHistory, applyDevSessionEvent, emptyDevSession, type DevSessionMap } from "@/lib/dev-session/reducer";
import { buildActiveRows } from "@/lib/dev-session/active-work";

import { ActiveWorkList } from "./active-work";
import { ContextMeter, contextMeterModel } from "./context-meter";
import { CommandItem, DevSessionDetailView, type DevSessionActions } from "./dev-session-detail";

Object.assign(globalThis, { React });

function fixtureView(mode: "running" | "done") {
	const start = 1_000_000;
	let map: DevSessionMap = {};
	devSessionFixtureEvents(start, mode).forEach((event, index) => {
		map = applyDevSessionEvent(map, event, { at: start + index * 500 });
	});
	return map;
}

const actions: DevSessionActions = { onStopCommand: () => {}, onStopSession: () => {}, onResume: () => {} };

test("painel: botão parar nos comandos em execução e Parar sessão no cabeçalho", () => {
	const view = fixtureView("running")[FIXTURE_SESSION_ID]!;
	const html = renderToStaticMarkup(<DevSessionDetailView actions={actions} now={view.startedAt + 1000} view={view} />);
	assert.equal((html.match(/data-stop-command/g) ?? []).length, 1, "só o comando em execução");
	assert.match(html, /aria-label="Parar comando"/);
	assert.match(html, /data-stop-session/);
	assert.match(html, /Parar sessão/);
	assert.doesNotMatch(html, /data-resume-session/);
	assert.doesNotMatch(html, /Atlas/);
});

test("painel: sessão parada oferece Retomar e não Parar sessão", () => {
	const view = fixtureView("done")[FIXTURE_SESSION_ID]!;
	const html = renderToStaticMarkup(<DevSessionDetailView actions={actions} now={view.startedAt + 1000} view={view} />);
	assert.match(html, /data-resume-session/);
	assert.match(html, /Retomar/);
	assert.doesNotMatch(html, /data-stop-session|data-stop-command/);
});

test("painel sem ações (pré-visualização) não mostra botões de parar nem retomar", () => {
	const view = fixtureView("running")[FIXTURE_SESSION_ID]!;
	const html = renderToStaticMarkup(<DevSessionDetailView now={view.startedAt + 1000} view={view} />);
	assert.doesNotMatch(html, /data-stop-|data-resume-session/);
});

test("comando concluído não tem botão de parar", () => {
	const view = fixtureView("done")[FIXTURE_SESSION_ID]!;
	const html = renderToStaticMarkup(<CommandItem command={view.commands[0]!} now={0} onStop={() => {}} />);
	assert.doesNotMatch(html, /data-stop-command/);
});

test("painel: linha neutra 'Contexto resumido' com antes → depois", () => {
	const map = applyContextCompacted(fixtureView("running"), { sessionId: FIXTURE_SESSION_ID, before: 118_000, after: 42_000 }, { at: 5, runId: "r", seq: 1 });
	const view = map[FIXTURE_SESSION_ID]!;
	const html = renderToStaticMarkup(<DevSessionDetailView now={view.startedAt + 1000} view={view} />);
	assert.match(html, /data-context-summary/);
	assert.match(html, /Contexto resumido · 118k → 42k tokens/);
	assert.doesNotMatch(html, /text-primary|--bot-accent/);
});

test("Em andamento: linha com conversa, tempo, selo de aprovação e ponto de não visto", () => {
	const { rows } = buildActiveRows(
		[
			{ kind: "dev", id: "d1", conversationId: "c1", conversationTitle: "Dev bot", botId: "b1", status: "RUNNING", repo: "octo/hello", branch: "feat/x", startedAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), awaitingApproval: true },
			{ kind: "dev", id: "d2", conversationId: "c1", conversationTitle: "Dev bot", botId: "b1", status: "STOPPED", repo: null, branch: null, startedAt: new Date(0).toISOString(), lastActiveAt: new Date(5000).toISOString(), awaitingApproval: false },
		],
		{},
	);
	const html = renderToStaticMarkup(<ActiveWorkList onOpen={() => {}} rows={rows} />);
	assert.match(html, /octo\/hello · feat\/x/);
	assert.match(html, /Dev bot/);
	assert.match(html, /data-awaiting-approval/);
	assert.match(html, /Aguardando aprovação/);
	assert.match(html, /data-unread-dot/);
	assert.doesNotMatch(html, /Atlas|--bot-accent/);
});

test("painel: medidor de contexto com barra fina, texto e detalhe em tokens", () => {
	const map = applyContextUsage(fixtureView("running"), { sessionId: FIXTURE_SESSION_ID, usedTokens: 54_000, windowTokens: 128_000, compactAtTokens: 102_400 }, { at: 5, runId: "r", seq: 1 });
	const view = map[FIXTURE_SESSION_ID]!;
	const html = renderToStaticMarkup(<DevSessionDetailView now={view.startedAt + 1000} view={view} />);
	assert.match(html, /data-context-meter/);
	assert.match(html, /aria-label="Contexto 42%. 54k de 128k tokens. Resume automaticamente em 80%"/);
	assert.match(html, /<svg/);
	assert.doesNotMatch(html, /Contexto 42% · resume em/);
	assert.doesNotMatch(html, /data-warn/);
	assert.match(html, /stroke-dashoffset/i);
	assert.doesNotMatch(html, /text-primary|--bot-accent/);
});

test("painel sem medição não mostra o medidor e mantém a linha de resumo", () => {
	const view = fixtureView("running")[FIXTURE_SESSION_ID]!;
	assert.doesNotMatch(renderToStaticMarkup(<DevSessionDetailView now={view.startedAt + 1000} view={view} />), /data-context-meter/);
	const compacted = applyContextCompacted(fixtureView("running"), { sessionId: FIXTURE_SESSION_ID, before: 118_000, after: 42_000 }, { at: 5, runId: "r", seq: 1 });
	const withBoth = applyContextUsage(compacted, { sessionId: FIXTURE_SESSION_ID, usedTokens: 42_000, windowTokens: 128_000, compactAtTokens: 102_400 }, { at: 6, runId: "r", seq: 2 })[FIXTURE_SESSION_ID]!;
	const html = renderToStaticMarkup(<DevSessionDetailView now={withBoth.startedAt + 1000} view={withBoth} />);
	assert.match(html, /data-context-meter/);
	assert.match(html, /data-context-summary/);
	assert.match(html, /Contexto 33%./);
});

test("anel: âmbar só a partir de 70% do ponto de resumo", () => {
	const model = (usedTokens: number) => contextMeterModel({ usedTokens, windowTokens: 100_000, compactAtTokens: 80_000 });
	assert.equal(model(55_000).warn, false);
	assert.equal(model(56_000).warn, true);
	assert.deepEqual([model(42_000).title, model(54_000).detail, model(1).compactNote], ["Contexto 42%", "54k de 100k tokens", "Resume automaticamente em 80%"]);
	const map = applyContextUsage({}, { sessionId: "s", usedTokens: 70_000, windowTokens: 100_000, compactAtTokens: 80_000 }, { at: 1 });
	assert.match(renderToStaticMarkup(<ContextMeter usage={map.s!.contextUsage!} />), /data-warn="true"/);
});

test("medidor: só o uso mais recente vale e o recuo depois do resumo aparece", () => {
	const usage = (usedTokens: number) => ({ sessionId: FIXTURE_SESSION_ID, usedTokens, windowTokens: 100_000, compactAtTokens: 80_000 });
	let map: DevSessionMap = {};
	map = applyContextUsage(map, usage(79_000), { at: 10, runId: "r", seq: 1 });
	map = applyContextUsage(map, usage(30_000), { at: 20, runId: "r", seq: 2 });
	assert.equal(map[FIXTURE_SESSION_ID]!.contextUsage!.usedTokens, 30_000);
	// replay do histórico (mais antigo) não regride o medidor
	map = applyDevHistory(map, [{ runId: "r", seq: 1, type: "context_usage", payload: usage(79_000), createdAt: new Date(10).toISOString() }]);
	assert.equal(map[FIXTURE_SESSION_ID]!.contextUsage!.usedTokens, 30_000);
	// histórico recarregado em um mapa vazio restaura o último
	const restored = applyDevHistory({}, [
		{ runId: "r", seq: 1, type: "context_usage", payload: usage(79_000), createdAt: new Date(10).toISOString() },
		{ runId: "r", seq: 2, type: "context_usage", payload: usage(30_000), createdAt: new Date(20).toISOString() },
	]);
	assert.equal(restored[FIXTURE_SESSION_ID]!.contextUsage!.usedTokens, 30_000);
	assert.deepEqual(contextMeterModel({ usedTokens: 150_000, windowTokens: 100_000, compactAtTokens: 80_000 }).used, 100);
	// evento sem sessão ou com janela inválida é ignorado
	assert.deepEqual(applyContextUsage({}, { usedTokens: 1, windowTokens: 100, compactAtTokens: 80 }, { at: 1 }), {});
	assert.deepEqual(applyContextUsage({}, { sessionId: "x", usedTokens: 1, windowTokens: 0, compactAtTokens: 0 }, { at: 1 }), {});
});

test("cabeçalho da sessão mostra o modelo em uso, discreto, quando o run informa", () => {
	const view = {
		...emptyDevSession("s-model", 0),
		contextUsage: { model: "anthropic/claude-sonnet-5.5", usedTokens: 1000, windowTokens: 100_000, compactAtTokens: 80_000, at: 1 },
	};
	const html = renderToStaticMarkup(<DevSessionDetailView now={1} view={view} />);
	assert.match(html, /data-dev-model[^>]*>Claude Sonnet 5\.5</);
	assert.doesNotMatch(renderToStaticMarkup(<DevSessionDetailView now={1} view={{ ...view, contextUsage: undefined }} />), /data-dev-model/);
});

test("medidor de contexto mostra o percentual como texto (não parece um spinner)", () => {
	const html = renderToStaticMarkup(<ContextMeter usage={{ usedTokens: 34_000, windowTokens: 100_000, compactAtTokens: 80_000 } as never} />);
	assert.match(html, /data-context-percent[^>]*>34%</);
	assert.doesNotMatch(html, /animate-spin/);
});
