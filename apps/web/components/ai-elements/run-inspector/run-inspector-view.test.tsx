import React from "react";
Object.assign(globalThis, { React });
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunInspection } from "@workspace/shared";
import { describeAction, describeContext, RunInspectorView, TokenBar } from "./run-inspector-view";

const tokens = { system: 400, tools: 300, history: 200, toolResults: 100, notes: 50, turn: 50 };
const inspection: RunInspection = {
	v: 1,
	runId: "run-1",
	status: "completed",
	model: "provider/model",
	origin: "chat",
	fullRequestEnabled: false,
	context: { mode: "fallback", reason: "no_watermark" },
	steps: [
		{ decisionIndex: 0, provider: "openrouter", model: "provider/model", durationMs: 1500, finishReason: "tool_calls", promptTokens: 1200, completionTokens: 40, cacheReadTokens: 800, cacheWriteTokens: 100, tokens, estimatedTotal: 1100, contextLength: 11000, messages: 5, toolCount: 2, toolNames: ["read_file", "web_fetch"], actions: [{ kind: "collapsed", count: 3 }, { kind: "summary", before: 9000, after: 2000 }], hasRequest: false },
		{ decisionIndex: 1, tokens, estimatedTotal: 1100, actions: [], hasRequest: true, request: { text: "{\"messages\":[]}", truncated: true } },
	],
	toolCalls: [
		{ id: "t1", name: "read_file", args: "{\"path\":\"/a\"}", status: "ok", durationMs: 30, decisionIndex: 0 },
		{ id: "t2", name: "web_fetch", status: "failed", durationMs: 2100, decisionIndex: 0, summary: "timeout" },
	],
	approvals: [{ id: "c1", title: "Enviar e-mail", status: "failed", detail: "sem permissão" }],
	errors: [{ message: "falha do provedor" }],
	totals: { steps: 2, toolCalls: 2, failedToolCalls: 1, promptTokens: 1200, completionTokens: 40, costUsd: 0.0123 },
};

test("a visão mostra resumo, contexto, barras, ações e ferramentas disponíveis", () => {
	const html = renderToStaticMarkup(<RunInspectorView inspection={inspection} />);
	assert.match(html, /class="run-inspector flex/);
	assert.match(html, /Histórico só de texto: sem marca d&#x27;água/);
	assert.match(html, /Passo 1/);
	assert.match(html, /cache lido 800/);
	assert.match(html, /Limpeza: 3 grupos colapsados/);
	assert.match(html, /Resumo aplicado/);
	assert.match(html, /2 ferramentas disponíveis/);
	assert.match(html, /read_file, web_fetch/);
	assert.match(html, /Pedido enviado \(redigido\), parcial/);
	assert.match(html, /falha do provedor/);
	assert.match(html, /Chamadas \(2\)/);
	assert.match(html, /Aprovações \(1\)/);
	assert.match(html, /US\$ 0\.0123/);
});

test("a barra empilhada tem um segmento por categoria e escala pelo maior passo", () => {
	const html = renderToStaticMarkup(<TokenBar scale={2200} tokens={tokens} />);
	assert.equal((html.match(/title="/g) ?? []).length, 6);
	assert.match(html, /width:50%/);
	const empty = renderToStaticMarkup(<TokenBar scale={1100} tokens={{ ...tokens, notes: 0, turn: 0 }} />);
	assert.equal((empty.match(/title="/g) ?? []).length, 4);
});

test("sem copiar quando não há handler; com handler mostra o botão", () => {
	assert.doesNotMatch(renderToStaticMarkup(<RunInspectorView inspection={inspection} />), /Copiar JSON/);
	assert.match(renderToStaticMarkup(<RunInspectorView inspection={inspection} onCopy={() => undefined} />), /Copiar JSON/);
	assert.match(renderToStaticMarkup(<RunInspectorView copied inspection={inspection} onCopy={() => undefined} />), /Copiado/);
});

test("textos de ações e do contexto em português", () => {
	assert.equal(describeAction({ kind: "trimmed", count: 1 }), "Cortou 1 mensagem");
	assert.equal(describeAction({ kind: "summary_failed" }), "Resumo falhou");
	assert.equal(describeContext({ mode: "carried", priorMessages: 12 }), "Transcrição carregada (12 mensagens)");
	assert.equal(describeContext({ mode: "first_turn" }), "Primeira mensagem da conversa");
});
