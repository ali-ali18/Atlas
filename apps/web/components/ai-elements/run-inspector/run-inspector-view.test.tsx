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
	assert.equal(describeAction({ kind: "compact", before: 48_200, after: 6_100 }), "Conversa compactada (48k para 6,1k)");
	assert.equal(describeAction({ kind: "compact" }), "Conversa compactada");
	assert.equal(describeContext({ mode: "carried", priorMessages: 12 }), "Transcrição carregada (12 mensagens)");
	assert.equal(describeContext({ mode: "first_turn" }), "Primeira mensagem da conversa");
});

test("lições do run: injetadas, usadas e a revisão do run anterior aparecem como ação", () => {
	const html = renderToStaticMarkup(
		<RunInspectorView
			inspection={{
				...inspection,
				lessons: { injected: ["Lab12", "Lcd34"], atStart: 1, loaded: [{ key: "mcp:c1", refs: ["Lcd34"] }], used: [{ ref: "Lab12", outcome: "helped" }], review: { runId: "r0", at: "2026-10-20T10:00:00.000Z", status: "reviewed", added: 1, retired: 2, rejected: 1, skillProposal: true } },
			}}
		/>,
	);
	assert.match(html, /data-run-lessons/);
	assert.match(html, /Lições injetadas: 2 \(\[Lab12\] \[Lcd34\]\)/);
	assert.match(html, /1 entrou ao carregar um conector/);
	assert.match(html, /\[Lab12\] ajudou/);
	assert.match(html, /Revisão de lições do run anterior: 1 nova, 2 aposentadas, 1 sugestão de skill \(1 descartada\)\./);
	assert.doesNotMatch(renderToStaticMarkup(<RunInspectorView inspection={inspection} />), /data-run-lessons/);
});

test("plano e regras: proposto, aprovado ou ajustado aparece; acertos das regras e o 'ajudou' também", () => {
	const html = renderToStaticMarkup(
		<RunInspectorView
			inspection={{
				...inspection,
				approvals: [
					{ id: "confirm-plan-run-1", title: "Criar propostas", status: "approved", plan: { steps: 3, state: "approved" } },
					{ id: "c1", title: "Enviar e-mail", status: "failed", detail: "sem permissão" },
				],
				hooks: {
					hits: [
						{ source: "plan", action: "blocked", tool: "mcp__erp__criar_proposta" },
						{ source: "rule", action: "blocked", tool: "mcp__erp__criar_proposta", ref: "L1abc", ruleKind: "required_args", detail: "faltam: pagamento" },
						{ source: "rule", action: "confirm", tool: "mcp__erp__criar_proposta", ref: "L2def", ruleKind: "confirm_always" },
					],
					helped: ["L1abc"],
				},
			}}
		/>,
	);
	assert.match(html, /data-run-plan/);
	assert.match(html, /Plano &quot;Criar propostas&quot; com 3 passos: aprovado\./);
	assert.match(html, /data-run-hooks/);
	assert.match(html, /Plano pendente barrou a escrita mcp__erp__criar_proposta\./);
	assert.match(html, /Regra \[L1abc\] \(required_args\) barrou mcp__erp__criar_proposta: faltam: pagamento\./);
	assert.match(html, /Regra \[L2def\] \(confirm_always\) forçou confirmação em mcp__erp__criar_proposta\./);
	assert.match(html, /Regras que ajudaram \(a chamada seguinte deu certo\): \[L1abc\]/);
	const adjusted = renderToStaticMarkup(<RunInspectorView inspection={{ ...inspection, approvals: [{ id: "p", title: "", status: "rejected", plan: { steps: 1, state: "adjusted" } }] }} />);
	assert.match(adjusted, /Plano com 1 passo: o usuário pediu ajuste\./);
	const clean = renderToStaticMarkup(<RunInspectorView inspection={inspection} />);
	assert.doesNotMatch(clean, /data-run-plan|data-run-hooks/);
});
