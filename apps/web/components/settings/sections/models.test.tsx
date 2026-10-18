import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EffectiveAccountConfig, OpenRouterModel } from "@workspace/shared";
import { ModelsSettingsView } from "./models";

Object.assign(globalThis, { React });

const catalog: OpenRouterModel[] = [
	{ id: "openai/gpt-4o-mini", name: "OpenAI: GPT-4o mini", provider: "openai", contextLength: 1, inputModalities: ["text", "image"], outputModalities: ["text"] },
	{ id: "deepseek/deepseek-v4", name: "DeepSeek: V4", provider: "deepseek", contextLength: 1, inputModalities: ["text"], outputModalities: ["text"] },
];

function effective(overrides: Record<string, unknown> = {}): EffectiveAccountConfig {
	return {
		models: {
			default: { value: "openai/gpt-4o-mini", source: "env" },
			fallbacks: { value: [], source: "default" },
			maintenance: { value: "openai/gpt-4o-mini", source: "default" },
			summary: { value: "openai/gpt-4o-mini", source: "default" },
			vision: { value: undefined, source: "default" },
			image: { value: undefined, source: "default" },
			coding: { value: undefined, source: "default" },
			...overrides,
		},
	} as unknown as EffectiveAccountConfig;
}

function render(props: Partial<React.ComponentProps<typeof ModelsSettingsView>> = {}) {
	return renderToStaticMarkup(
		<ModelsSettingsView
			effective={effective()}
			models={catalog}
			onChange={() => {}}
			status="idle"
			{...props}
		/>,
	);
}

test("Modelos: um seletor por configuração, cada um com rótulo acessível", () => {
	const html = render();
	for (const [id, label] of [
		["default", "Modelo padrão"],
		["maintenance", "Modelo de manutenção"],
		["vision", "Modelo para ler imagens"],
		["image", "Modelo para gerar imagens"],
		["coding", "Modelo para código"],
	]) {
		assert.match(html, new RegExp(`for="settings-model-${id}"[^>]*>${label}<`));
		assert.match(html, new RegExp(`id="settings-model-${id}"`));
	}
});

test("Modelos: herdando, o seletor mostra a origem e o modelo (padrão do servidor)", () => {
	const html = render();
	assert.match(html, /Herdar \(GPT-4o mini\)/);
	assert.match(html, /Herdar \(desligado\)/, "imagem sem valor herdado");
	assert.match(html, /Herdar \(sem reserva\)/, "visão sem valor herdado");
});

test("Modelos: valor do usuário mostra o modelo, não 'Herdar'", () => {
	const html = render({
		effective: effective({ default: { value: "deepseek/deepseek-v4", source: "user" } }),
	});
	assert.match(html, /V4/);
	assert.doesNotMatch(html, /Herdar: padrão do servidor/);
});

test("Modelos: reservas são uma linha comum (sem Collapsible)", () => {
	const html = render();
	assert.match(html, /Modelos de reserva/);
	assert.doesNotMatch(html, /Mostrar configurações avançadas/);
});

test("Modelos: título do grupo é opcional (sem título dentro de outro grupo, só as linhas)", () => {
	assert.match(render({ title: "Modelos auxiliares" }), /<h3[^>]*>Modelos auxiliares<\/h3>/);
	assert.doesNotMatch(render(), /<h3/);
});

test("Modelos: carregando mostra o estado sem seletores; erro e salvar aparecem como alerta", () => {
	const html = render({ effective: null });
	assert.match(html, /Carregando…/);
	assert.doesNotMatch(html, /id="settings-model-default"/);
	assert.match(render({ effective: null, loadError: "Não foi possível carregar as configurações." }), /role="alert"[^>]*>Não foi possível carregar/);
	assert.match(render({ status: "error", saveError: "Informe um id de modelo do OpenRouter." }), /role="alert"[^>]*>Informe um id/);
});

test("Modelos: aviso quando o servidor não tem chave do OpenRouter", () => {
	assert.match(render({ openrouterKey: false }), /Chave do OpenRouter não configurada no servidor/);
	assert.doesNotMatch(render({ openrouterKey: true }), /Chave do OpenRouter não configurada/);
});

test("Modelos: a busca esconde o que não casou", () => {
	const html = render({ isVisible: (id) => id === "modelos.visao" });
	assert.match(html, /Modelo para ler imagens/);
	assert.doesNotMatch(html, /Modelo padrão/);
	assert.doesNotMatch(html, /Modelos de reserva/);
});

const dictation = {
	provider: "openrouter" as const,
	defaultModel: "openai/whisper-large-v3",
	models: [
		{ id: "openai/whisper-large-v3", name: "OpenAI: Whisper Large V3", vendor: "openai", pricePerMinuteUsd: 0.00045 },
		{ id: "elevenlabs/scribe-v2", name: "ElevenLabs: Scribe v2", vendor: "elevenlabs", pricePerMinuteUsd: 0.0018 },
	],
};

test("Modelos: 'Modelo de ditado' é um seletor só, com rótulo e padrão 'Padrão (<nome>)', sem preço", () => {
	const html = render({ dictation, effective: effective({ stt: { value: undefined, source: "default" } }) });
	assert.match(html, /for="settings-model-stt"[^>]*>Modelo de ditado</);
	assert.match(html, /id="settings-model-stt"/);
	assert.match(html, /Padrão \(Whisper Large V3\)/);
	assert.doesNotMatch(html, /0\.00045|US\$|\/min/);
});

test("Modelos: com escolha do usuário o seletor mostra só o nome do modelo, sem prefixo do fornecedor", () => {
	const html = render({ dictation, effective: effective({ stt: { value: "elevenlabs/scribe-v2", source: "user" } }) });
	assert.match(html, /Scribe v2/);
	assert.doesNotMatch(html, /ElevenLabs: Scribe/);
	assert.doesNotMatch(html, /Padrão \(Whisper/);
});

test("Modelos: sem STT no servidor a configuração de ditado some", () => {
	const html = render({ dictation: null, effective: effective({ stt: { value: undefined, source: "default" } }) });
	assert.doesNotMatch(html, /Modelo de ditado/);
	assert.doesNotMatch(html, /settings-model-stt/);
});

test("Modelos: a busca esconde o ditado quando não casou", () => {
	const html = render({ dictation, effective: effective({ stt: { value: undefined, source: "default" } }), isVisible: (id) => id === "modelos.visao" });
	assert.doesNotMatch(html, /Modelo de ditado/);
});

test("Modelo para código: sem escolha herda 'modelo do bot'; com escolha mostra o modelo e grava models.coding", () => {
	assert.match(render(), /Herdar \(modelo do bot\)/);
	const html = render({ effective: effective({ coding: { value: "deepseek/deepseek-v4", source: "user" } }) });
	assert.match(html, /id="settings-model-coding"[^>]*>[^]*?V4/);
});

test("Modelos: aviso quando o modelo escolhido não tem a capacidade da função", () => {
	const noTools: OpenRouterModel = { id: "acme/chat-only", name: "Acme: Chat", provider: "acme", contextLength: 1, inputModalities: ["text"], supportedParameters: ["temperature"] };
	const html = render({
		models: [...catalog, noTools],
		effective: effective({ maintenance: { value: "acme/chat-only", source: "user" }, vision: { value: "deepseek/deepseek-v4", source: "user" } }),
	});
	assert.match(html, /resumo e revisão de memória podem falhar/);
	assert.match(html, /Este modelo não lê imagens/);
	assert.doesNotMatch(render(), /role="note"/);
});
