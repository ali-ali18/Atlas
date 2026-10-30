import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubagentTaskView } from "@workspace/shared";

import { FIXTURE_SESSION_ID, devSessionFixtureEvents, devSessionFixtureMode } from "@/lib/dev-session/fixture";
import { applyDevSessionEvent, type DevSessionMap } from "@/lib/dev-session/reducer";
import { SubagentCardView } from "@/components/ai-elements/subagents/subagents-block";
import { SubagentDetailView } from "@/components/ai-elements/subagents/subagent-detail";
import { subagentFailureReason } from "@/components/ai-elements/subagents/subagent-status";

import { DevSessionCardView } from "./dev-session-card";
import { CommandItem, DevSessionDetailView, DiffView, ExitBadge, TerminalOutput } from "./dev-session-detail";

Object.assign(globalThis, { React });

function fixtureView(mode: "running" | "done") {
	const start = 1_000_000;
	let map: DevSessionMap = {};
	devSessionFixtureEvents(start, mode).forEach((event, index) => {
		map = applyDevSessionEvent(map, event, { at: start + index * 500 });
	});
	return map[FIXTURE_SESSION_ID]!;
}

test("linha da sessão em andamento: uma linha com título, status e tempo, sem card grande", () => {
	const view = fixtureView("running");
	const html = renderToStaticMarkup(<DevSessionCardView now={view.startedAt + 252_000} view={view} />);
	assert.match(html, /<button/);
	assert.match(html, /acme\/painel-app · feat\/painel/);
	assert.match(html, /data-dev-timer="true">4m12s</);
	assert.match(html, /data-dev-extra="true"><span class="font-mono">pnpm test</);
	assert.doesNotMatch(html, /agora:|Trabalhando|emerald-500\/40|text-primary/);
	assert.doesNotMatch(html, /Atlas/);
});

test("linha da sessão parada mostra Parada e o tempo congelado", () => {
	const view = fixtureView("done");
	const html = renderToStaticMarkup(<DevSessionCardView now={view.startedAt + 9_999_999} view={view} />);
	assert.match(html, /Parada · \d/);
	assert.match(html, /3 comandos · 2 arquivos · \+8 −3/);
});

test("detalhe sem abas: Alterações, Tarefas em segundo plano e Plano empilhados", () => {
	const view = fixtureView("running");
	const html = renderToStaticMarkup(<DevSessionDetailView now={view.startedAt + 1000} view={view} />);
	assert.doesNotMatch(html, /role="tab"/);
	for (const label of ["Alterações", "Tarefas em segundo plano", "Plano 2/4", "Em execução", "Concluídas"]) assert.match(html, new RegExp(label));
	assert.match(html, /Trabalhando · 1s/);
	assert.doesNotMatch(html, /Trabalhando há/);
	assert.match(html, /panel\.tsx/);
	assert.match(html, /pnpm test/);
	assert.match(html, /Shell · <span class="text-destructive">Falhou<\/span>/);
	assert.doesNotMatch(html, /Etapas/);
});

test("item de comando: saída sem ANSI, rolagem horizontal e selo de saída", () => {
	const view = fixtureView("running");
	const out = renderToStaticMarkup(<TerminalOutput command={view.commands[1]!} />);
	assert.match(out, /error TS2322/);
	assert.doesNotMatch(out, //);
	assert.match(out, /whitespace-pre /);
	assert.doesNotMatch(out, /break-all/);
	assert.match(renderToStaticMarkup(<ExitBadge command={view.commands[1]!} />), /✗ 2/);
	assert.match(renderToStaticMarkup(<ExitBadge command={view.commands[0]!} />), /✓ 0/);
	const item = renderToStaticMarkup(<CommandItem command={view.commands[0]!} now={0} />);
	assert.match(item, /Shell · <span class="">Concluído/);
});

test("diff colore linhas adicionadas, removidas e hunks", () => {
	const html = renderToStaticMarkup(<DiffView diff={"@@ -1 +1 @@\n-velho\n+novo\n igual"} />);
	assert.match(html, /data-diff-line="hunk"/);
	assert.match(html, /data-diff-line="remove"[^>]*>-velho/);
	assert.match(html, /data-diff-line="add"[^>]*>\+novo/);
});

const task: SubagentTaskView = {
	taskIndex: 0,
	title: "Mapear usos",
	goal: "Mapear onde o Panel é usado.",
	status: "running",
	toolsUsed: ["grep"],
	model: "openai/gpt-5",
};
const track = { startedAt: 1000, tools: [{ name: "grep", count: 2, failed: 0 }], lastTool: "grep" };

test("cartão e detalhe de subagente com cronômetro ao vivo", () => {
	const card = renderToStaticMarkup(<SubagentCardView groupId="g" now={73_000} task={task} track={track} />);
	assert.match(card, /Mapear usos/);
	assert.match(card, /data-dev-timer="true">1m12s</);
	assert.match(card, /<span class="font-mono">grep</);
	assert.doesNotMatch(card, /agora:/);
	const detail = renderToStaticMarkup(<SubagentDetailView groupId="g" now={73_000} task={{ ...task, status: "ok", summary: "Feito." }} track={{ ...track, endedAt: 31_000 }} />);
	assert.match(detail, /Objetivo/);
	assert.match(detail, /Concluído · 30s/);
	assert.match(detail, /×2/);
	assert.match(detail, /Feito\./);
});

test("fixture só liga fora de produção e com o parâmetro", () => {
	assert.equal(devSessionFixtureMode("?devSessionFixture=1", "development"), "running");
	assert.equal(devSessionFixtureMode("?devSessionFixture=done", "development"), "done");
	assert.equal(devSessionFixtureMode("?devSessionFixture=1", "production"), null);
	assert.equal(devSessionFixtureMode("", "development"), null);
});

test("painel mostra a seção Tempo com modelo, comandos, aprovação, preparação e passos", () => {
	const view = fixtureView("done");
	const timing = { type: "dev_timing" as const, sessionId: FIXTURE_SESSION_ID, startedAt: 1, firstTokenMs: 6_000, toolsMs: 70_000, shellMs: 60_000, pollWaitMs: 5_000, approvalMs: 180_000, modelMs: 130_000, setupMs: 40_000, steps: 18 };
	const html = renderToStaticMarkup(<DevSessionDetailView now={view.startedAt + 1000} view={{ ...view, timing: { r1: timing } }} />);
	assert.match(html, /Tempo/);
	assert.match(html, /Modelo 2m10s · Comandos 1m05s · Esperando aprovação 3m00s · Preparação 40s · 18 passos/);
	assert.doesNotMatch(renderToStaticMarkup(<DevSessionDetailView now={view.startedAt + 1000} view={view} />), /data-dev-timing/);
});

function viewWithCommands(commands: Array<{ id: string; bg: boolean }>) {
	const sessionId = "s-bg";
	let map: DevSessionMap = {};
	let at = 1_000;
	const apply = (event: Parameters<typeof applyDevSessionEvent>[1]) => {
		map = applyDevSessionEvent(map, event, { at: (at += 100) });
	};
	apply({ type: "dev_session_status", sessionId, status: "RUNNING", tier: "small", repo: "o/r", branch: "main" });
	for (const c of commands) {
		apply({ type: "shell_started", sessionId, callId: c.id, jobId: `j-${c.id}`, cmd: `cmd ${c.id}`, cwd: "/w", startedAt: new Date(at).toISOString() });
		if (c.bg) apply({ type: "shell_done", sessionId, callId: c.id, jobId: `j-${c.id}`, exitCode: null, durationMs: 30_000, endedReason: "background_running" });
		apply({ type: "shell_done", sessionId, callId: c.id, jobId: `j-${c.id}`, exitCode: 0, durationMs: c.bg ? 45_000 : 0, endedReason: "exit" });
	}
	return map[sessionId]!;
}

test("comandos curtos de primeiro plano não aparecem em Tarefas em segundo plano", () => {
	const view = viewWithCommands(Array.from({ length: 20 }, (_, i) => ({ id: `fg${i}`, bg: false })));
	const html = renderToStaticMarkup(<DevSessionDetailView now={view.startedAt + 1000} view={view} />);
	assert.match(html, /Nenhuma tarefa em segundo plano/);
	assert.doesNotMatch(html, /data-command-item/);
	assert.doesNotMatch(html, /cmd fg0/);
});

test("só o que foi para segundo plano entra; concluídas limitadas às 5 mais recentes com Ver todas", () => {
	const specs = [...Array.from({ length: 8 }, (_, i) => ({ id: `bg${i}`, bg: true })), { id: "fgx", bg: false }];
	const view = viewWithCommands(specs);
	const html = renderToStaticMarkup(<DevSessionDetailView now={view.startedAt + 1000} view={view} />);
	assert.equal((html.match(/data-command-item/g) ?? []).length, 5);
	assert.match(html, /cmd bg7/);
	assert.doesNotMatch(html, /cmd bg2\b/);
	assert.doesNotMatch(html, /cmd fgx/);
	assert.match(html, /Ver todas \(8\)/);
});

test("com 5 ou menos concluídas não há Ver todas", () => {
	const view = viewWithCommands([{ id: "bg1", bg: true }]);
	const html = renderToStaticMarkup(<DevSessionDetailView now={view.startedAt + 1000} view={view} />);
	assert.doesNotMatch(html, /data-show-all-done/);
	assert.match(html, /cmd bg1/);
});

test("sessão parada: shell_started atrasado não fica 'em execução'", () => {
	const sessionId = "s-late";
	let map: DevSessionMap = {};
	map = applyDevSessionEvent(map, { type: "dev_session_status", sessionId, status: "RUNNING", tier: "small" }, { at: 1000 });
	map = applyDevSessionEvent(map, { type: "dev_session_status", sessionId, status: "STOPPED", tier: "small" }, { at: 2000 });
	map = applyDevSessionEvent(map, { type: "shell_started", sessionId, callId: "late", jobId: "jl", cmd: "sleep 99", cwd: "/w", startedAt: new Date(2500).toISOString() }, { at: 2500 });
	const command = map[sessionId]!.commands[0]!;
	assert.equal(command.status, "done");
	assert.equal(command.endedReason, "stopped");
	assert.equal(map[sessionId]!.commands.some((c) => c.status === "running"), false);
});

test("subagente que falhou mostra o motivo na linha; o relatório segue no detalhe", () => {
	const failed: SubagentTaskView = {
		taskIndex: 1,
		title: "Bobinho",
		goal: "Escreva o resumo da Semana 2.",
		status: "failed",
		toolsUsed: [],
		summary: "The sub-agent returned no report: it ended without any text or findings, so nothing was done for this task. Do it yourself, or tell the user plainly that this part is missing.",
	};
	const card = renderToStaticMarkup(<SubagentCardView groupId="g" now={0} task={failed} />);
	assert.match(card, /Bobinho/);
	assert.match(card, /Falhou/);
	assert.match(card, /data-subagent-reason/);
	assert.match(card, /The sub-agent returned no report/);
	const detail = renderToStaticMarkup(<SubagentDetailView groupId="g" now={0} task={failed} />);
	assert.match(detail, /Resumo/);
	assert.match(detail, /tell the user plainly/);
	// tarefa concluída não mostra motivo
	const ok = renderToStaticMarkup(<SubagentCardView groupId="g" now={0} task={{ ...failed, status: "ok", summary: "R$ 12,90" }} />);
	assert.doesNotMatch(ok, /data-subagent-reason/);
});

test("subagentFailureReason: primeira linha útil, sem prefixo técnico, cortada", () => {
	assert.equal(subagentFailureReason({ status: "ok", summary: "x" }), null);
	assert.equal(subagentFailureReason({ status: "failed", summary: "Sub-agent failed: provider down" }), "provider down");
	assert.equal(subagentFailureReason({ status: "partial", summary: "\n[stopped early: deadline]" }), null);
	assert.equal(subagentFailureReason({ status: "failed", summary: "a".repeat(200) })!.length, 90);
});
