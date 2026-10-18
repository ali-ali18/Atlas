import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { FIXTURE_CHECKS, FIXTURE_PR, FIXTURE_SESSION_ID, devSessionFixtureEvents, devSessionFixtureMode } from "@/lib/dev-session/fixture";
import { applyDevSessionEvent, type DevSessionMap } from "@/lib/dev-session/reducer";

import { DevSessionCardView } from "./dev-session-card";
import { DevSessionDetailView } from "./dev-session-detail";
import { checkVisual, PullRequestBody, safeExternalUrl } from "./pr-section";

Object.assign(globalThis, { React });

function prView() {
	const start = 1_000_000;
	let map: DevSessionMap = {};
	devSessionFixtureEvents(start, "pr").forEach((event, index) => {
		map = applyDevSessionEvent(map, event, { at: start + index * 500 });
	});
	return map[FIXTURE_SESSION_ID]!;
}

test("painel: seção Pull request com número, título, estado, ramos, link externo e checks", () => {
	const view = prView();
	const html = renderToStaticMarkup(<DevSessionDetailView now={view.startedAt + 1000} view={view} />);
	assert.match(html, />Pull request</);
	assert.match(html, /#42<\/span> Tratar título vazio no Panel/);
	assert.match(html, /data-pr-state="open"[^>]*>.*Aberta/);
	assert.match(html, /main ← feat\/painel/);
	assert.match(html, /href="https:\/\/github\.com\/ali-ali18\/agent-bot\/pull\/42"/);
	assert.match(html, /target="_blank"/);
	assert.match(html, /Abrir no GitHub/);
	assert.match(html, /1 falhou · 3 de 5 passaram/);
	assert.equal((html.match(/data-ci-check/g) ?? []).length, 5);
	for (const state of ["passed", "failed", "running", "skipped"]) assert.match(html, new RegExp(`data-ci-state="${state}"`));
	assert.match(html, /test \(node 22\)/);
	assert.match(html, /2m31s/);
	assert.doesNotMatch(html, /Atlas/);
});

test("sem PR a seção não aparece", () => {
	const view = { ...prView(), pr: undefined, ci: undefined };
	assert.doesNotMatch(renderToStaticMarkup(<DevSessionDetailView now={view.startedAt} view={view} />), />Pull request</);
});

test("cada estado do PR tem rótulo próprio e checks ainda não lidos mostram Verificando", () => {
	for (const [state, label] of [["draft", "Rascunho"], ["merged", "Mesclada"], ["closed", "Fechada"]] as const) {
		assert.match(renderToStaticMarkup(<PullRequestBody pr={{ ...FIXTURE_PR, state }} />), new RegExp(`data-pr-state="${state}"[^>]*>.*${label}`));
	}
	assert.match(renderToStaticMarkup(<PullRequestBody pr={FIXTURE_PR} />), /Verificando…/);
	assert.match(renderToStaticMarkup(<PullRequestBody ci={{ checks: [], summary: "none", at: 0 }} pr={FIXTURE_PR} />), /Sem verificações ainda/);
});

test("ícone por verificação e links só http(s)", () => {
	assert.deepEqual(FIXTURE_CHECKS.map(checkVisual), ["passed", "passed", "failed", "running", "skipped"]);
	assert.equal(checkVisual({ status: "queued", conclusion: null }), "queued");
	assert.equal(checkVisual({ status: "completed", conclusion: "cancelled" }), "failed");
	assert.equal(safeExternalUrl("javascript:alert(1)"), null);
	assert.equal(safeExternalUrl("not a url"), null);
	assert.equal(safeExternalUrl(undefined), null);
	assert.equal(safeExternalUrl("https://github.com/x/y/pull/1"), "https://github.com/x/y/pull/1");
	const html = renderToStaticMarkup(<PullRequestBody ci={{ checks: [{ name: "x", status: "completed", conclusion: "success", url: "javascript:alert(1)" }], summary: "passing", at: 0 }} pr={{ ...FIXTURE_PR, url: "javascript:alert(1)" }} />);
	assert.doesNotMatch(html, /javascript:/);
});

test("cartão do chat: linha 2 traz PR #42 e checks antes dos contadores", () => {
	const view = { ...prView(), runActive: false };
	const html = renderToStaticMarkup(<DevSessionCardView now={view.startedAt + 9_999} view={view} />);
	assert.match(html, /data-dev-extra="true">PR #42 · checks ✗ · 3 comandos/);
});

test("fixture pr só liga com o parâmetro e fora de produção", () => {
	assert.equal(devSessionFixtureMode("?devSessionFixture=pr", "development"), "pr");
	assert.equal(devSessionFixtureMode("?devSessionFixture=pr", "production"), null);
});

test("painel: PR aberta oferece Testar de novo (só com a ação); encerrada não", () => {
	const view = prView();
	const withAction = renderToStaticMarkup(<DevSessionDetailView actions={{ onStopCommand: () => undefined, onStopSession: () => undefined, onResume: () => undefined, onRetestPr: () => undefined }} now={view.startedAt + 1000} view={view} />);
	assert.match(withAction, /data-retest-pr/);
	assert.match(withAction, />Testar de novo</);
	const without = renderToStaticMarkup(<DevSessionDetailView now={view.startedAt + 1000} view={view} />);
	assert.doesNotMatch(without, /data-retest-pr/);
	const merged = { ...view, pr: { ...view.pr!, state: "merged" as const } };
	const closed = renderToStaticMarkup(<DevSessionDetailView actions={{ onStopCommand: () => undefined, onStopSession: () => undefined, onResume: () => undefined, onRetestPr: () => undefined }} now={view.startedAt + 1000} view={merged} />);
	assert.doesNotMatch(closed, /data-retest-pr/);
});
