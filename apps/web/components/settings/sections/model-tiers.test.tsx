import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EffectiveAccountConfig, ModelTiers, OpenRouterModel } from "@workspace/shared";
import { ModelTiersSettingsView, TIER_CAPTION, TIER_ITEM_IDS } from "./model-tiers";
import { SETTINGS_ITEMS } from "../settings-registry";

Object.assign(globalThis, { React });

const catalog: OpenRouterModel[] = [
	{ id: "openai/gpt-4o-mini", name: "OpenAI: GPT-4o mini", provider: "openai", contextLength: 1, inputModalities: ["text"], outputModalities: ["text"] },
	{ id: "deepseek/deepseek-v4", name: "DeepSeek: V4", provider: "deepseek", contextLength: 1, inputModalities: ["text"], outputModalities: ["text"] },
	{ id: "anthropic/claude-x", name: "Anthropic: Claude X", provider: "anthropic", contextLength: 1, inputModalities: ["text"], outputModalities: ["text"] },
];

function effective(tiers: ModelTiers = {}, classify = false): EffectiveAccountConfig {
	const has = Object.keys(tiers).length > 0;
	return {
		models: {
			tiers: { value: tiers, source: has ? "user" : "default" },
			classifyWithReviewer: { value: classify, source: classify ? "user" : "default" },
		},
	} as unknown as EffectiveAccountConfig;
}

function render(props: Partial<React.ComponentProps<typeof ModelTiersSettingsView>> = {}) {
	return renderToStaticMarkup(
		<ModelTiersSettingsView effective={effective()} models={catalog} onChange={() => {}} status="idle" title="Modelos por dificuldade" {...props} />,
	);
}

test("Níveis: grupo com título, legenda e as três linhas Fácil, Média e Difícil", () => {
	const html = render();
	assert.ok(html.includes(">Modelos por dificuldade<"));
	assert.ok(html.includes(TIER_CAPTION));
	assert.equal(TIER_CAPTION, "Até 3 modelos por nível; o primeiro é o principal, os outros entram se ele falhar.");
	for (const label of ["Fácil", "Média", "Difícil"]) assert.ok(html.includes(`>${label}<`), label);
});

test("Níveis: vazios herdam o padrão e oferecem Adicionar, sem 'Voltar ao padrão'", () => {
	const html = render();
	assert.equal((html.match(/Usa o modelo padrão\./g) ?? []).length, 3);
	assert.equal((html.match(/>Adicionar</g) ?? []).length, 3);
	assert.doesNotMatch(html, /Voltar ao padrão/);
});

test("Níveis: modelos do nível aparecem em ordem, com subir (desligado no 1º) e remover", () => {
	const html = render({ effective: effective({ easy: ["openai/gpt-4o-mini", "deepseek/deepseek-v4"] }) });
	assert.ok(html.indexOf("GPT-4o mini") < html.indexOf(">V4<"));
	assert.match(html, /disabled=""[^>]*aria-label="Subir Fácil 1"/);
	assert.doesNotMatch(html, /disabled=""[^>]*aria-label="Subir Fácil 2"/);
	assert.match(html, /aria-label="Remover Fácil 2"/);
	assert.match(html, /Voltar ao padrão/);
	assert.equal((html.match(/Usa o modelo padrão\./g) ?? []).length, 2, "só Média e Difícil herdam");
});

test("Níveis: com 3 modelos some o Adicionar daquele nível", () => {
	const html = render({ effective: effective({ hard: ["openai/gpt-4o-mini", "deepseek/deepseek-v4", "anthropic/claude-x"] }) });
	assert.equal((html.match(/>Adicionar</g) ?? []).length, 2);
});

test("Revisor: interruptor com a legenda de custo; reflete o valor da conta", () => {
	const off = render();
	assert.match(off, /for="settings-model-classifier"[^>]*>Classificar com o revisor</);
	assert.ok(off.includes("Mais preciso, custa um pouco mais por mensagem."));
	assert.match(off, /role="switch"[^>]*aria-checked="false"/);
	const on = render({ effective: effective({}, true) });
	assert.match(on, /role="switch"[^>]*aria-checked="true"/);
});

test("Níveis: nunca usa a palavra Atlas e carrega sem a conta", () => {
	const html = render({ effective: null });
	assert.doesNotMatch(html, /Atlas/);
	assert.ok(html.includes("Carregando…"));
});

test("Níveis: itens filtrados pela busca somem; os ids estão no registro de busca", () => {
	const html = render({ isVisible: (id) => id === "modelos.nivel-media" });
	assert.ok(html.includes(">Média<"));
	assert.ok(!html.includes(">Fácil<"));
	assert.ok(html.includes(TIER_CAPTION), "a legenda fica enquanto algum nível aparece");
	const registered = new Set(SETTINGS_ITEMS.map((item) => item.id));
	for (const id of TIER_ITEM_IDS) assert.ok(registered.has(id), id);
	const classifier = SETTINGS_ITEMS.find((item) => item.id === "modelos.classificador");
	assert.equal(classifier?.section, "modelos");
});
