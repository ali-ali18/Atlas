import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UsageResponse, UsageTotals } from "@workspace/shared";
import { barPercent, runsLabel, totalCostLabel } from "../usage-state";
import { UsageSettingsView } from "./usage";

Object.assign(globalThis, { React });

const noop = () => {};
const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({
	runs: 3,
	costUsd: 1.5,
	costUnknownCalls: 0,
	planCalls: 0,
	promptTokens: 12000,
	completionTokens: 3000,
	cachedTokens: 0,
	...over,
});

function response(over: Partial<UsageResponse> = {}): UsageResponse {
	return {
		period: "7d",
		tz: "America/Sao_Paulo",
		from: "2026-09-29T03:00:00.000Z",
		to: "2026-10-06T03:00:00.000Z",
		totals: totals(),
		byBot: [{ ...totals(), key: "b1", botId: "b1", name: "Ana" }],
		byModel: [
			{ ...totals({ costUsd: 1, runs: 2 }), key: "openai/gpt-4o-mini", model: "openai/gpt-4o-mini" },
			{ ...totals({ costUsd: 0.5, runs: 1 }), key: "__others__", model: "Outros" },
		],
		...over,
	};
}

function render(props: Partial<React.ComponentProps<typeof UsageSettingsView>> = {}) {
	return renderToStaticMarkup(
		<UsageSettingsView
			data={response()}
			error={null}
			loading={false}
			onPeriodChange={noop}
			onRetry={noop}
			period="7d"
			{...props}
		/>,
	);
}

test("Uso: período em dropdown rotulado e total em US$", () => {
	const html = render();
	assert.match(html, /for="settings-usage-period"[^>]*>Janela de tempo</);
	assert.match(html, /id="settings-usage-period"/);
	assert.match(html, />Últimos 7 dias</);
	assert.match(html, /US\$ 1\.5000/);
	assert.match(html, />3 execuções</);
	assert.doesNotMatch(html, /custo parcial/);
});

test("Uso: custo parcial mostra quantas chamadas ficaram sem custo", () => {
	const html = render({ data: response({ totals: totals({ costUnknownCalls: 2 }) }) });
	assert.match(html, /custo parcial: 2 chamadas sem custo/);
});

test("Uso: só plano ChatGPT não vira US$ 0", () => {
	const plan = totals({ costUsd: null, planCalls: 4, runs: 2 });
	const html = render({
		data: response({
			totals: plan,
			byModel: [{ ...plan, key: "chatgpt/gpt-5", model: "chatgpt/gpt-5" }],
		}),
	});
	assert.match(html, /Chamadas no plano ChatGPT/);
	assert.match(html, /<dd[^>]*>4</);
	assert.match(html, />plano</, "linha do modelo mostra 'plano', sem valor em dólar");
	assert.doesNotMatch(html, /US\$ 0/);
	assert.match(html, /custo não informado/, "total sem custo conhecido");
});

test("Uso: por bot e por modelo com nome amigável, ícone e barra proporcional", () => {
	const html = render({
		models: [
			{ id: "openai/gpt-4o-mini", name: "OpenAI: GPT-4o mini", provider: "openai", contextLength: 1, inputModalities: ["text"], outputModalities: ["text"] },
		],
	});
	assert.match(html, /aria-label="Por bot"/);
	assert.match(html, /aria-label="Por modelo"/);
	assert.match(html, />Ana</);
	assert.match(html, />GPT-4o mini</, "modelDisplayName tira o prefixo do fornecedor");
	assert.match(html, /<img[^>]*alt="openai logo"/);
	assert.match(html, />Outros</);
	assert.match(html, /width:100%/);
	assert.match(html, /width:50%/);
});

test("Uso: vazio mostra 'Sem uso neste período' e nenhuma lista", () => {
	const empty = totals({ runs: 0, costUsd: null, promptTokens: 0, completionTokens: 0 });
	const html = render({ data: response({ totals: empty, byBot: [], byModel: [] }) });
	assert.match(html, /Sem uso neste período/);
	assert.doesNotMatch(html, /Por modelo/);
	assert.doesNotMatch(html, /<dl/);
});

test("Uso: carregando e erro (com 'Tentar de novo')", () => {
	assert.match(render({ data: null, loading: true }), /role="status"[^>]*>Carregando…/);
	const failed = render({ data: null, error: "Não foi possível carregar o uso." });
	assert.match(failed, /role="alert"[^>]*>Não foi possível carregar o uso\./);
	assert.match(failed, />Tentar de novo</);
	assert.doesNotMatch(failed, /Sem uso neste período/);
});

test("usage-state: rótulos e barras", () => {
	assert.equal(runsLabel(1), "1 execução");
	assert.equal(runsLabel(2), "2 execuções");
	assert.match(totalCostLabel({ costUsd: 0.25, costUnknownCalls: 1 }), /custo parcial: 1 chamada sem custo/);
	const rows = [{ costUsd: 2, runs: 1 }, { costUsd: 0.5, runs: 9 }, { costUsd: null, runs: 3 }];
	assert.deepEqual(rows.map((row) => barPercent(row, rows)), [100, 25, 0]);
	const planOnly = [{ costUsd: null, runs: 4 }, { costUsd: null, runs: 1 }];
	assert.deepEqual(planOnly.map((row) => barPercent(row, planOnly)), [100, 25]);
	assert.equal(barPercent({ costUsd: null, runs: 0 }, [{ costUsd: null, runs: 0 }]), 0);
});
