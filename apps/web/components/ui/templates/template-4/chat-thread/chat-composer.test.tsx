import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatComposer } from "./chat-composer";
Object.assign(globalThis, { React });

function render(props: Partial<React.ComponentProps<typeof ChatComposer>> = {}) {
	return renderToStaticMarkup(
		<ChatComposer agentName="Fixture" model="gpt-4o" onSend={() => {}} {...props} />,
	);
}

test("run ativo com entrada vazia: botão Parar no lugar de Enviar", () => {
	const html = render({ runActive: true, onStop: () => {} });
	assert.ok(html.includes('aria-label="Parar"'));
	assert.ok(!html.includes("Enviar mensagem"));
});

test("sem run e ditado indisponível: Enviar desabilitado, sem Parar", () => {
	const html = render({ onStop: () => {} });
	assert.match(buttonTag(html, "Enviar mensagem"), /disabled/);
	assert.ok(!html.includes('aria-label="Parar"'));
});

test("não há cabeçalho de run (status, Pausar, Retomar)", () => {
	for (const runActive of [true, false]) {
		const html = render({ runActive, onStop: () => {} });
		assert.ok(!html.includes("está trabalhando"));
		assert.ok(!html.includes("Pausar"));
		assert.ok(!html.includes("Retomar"));
		assert.ok(!html.includes("composer-run-header"));
	}
});

test("não há mais opções de envio (Enfileirar/Interromper)", () => {
	for (const runActive of [true, false]) {
		const html = render({ runActive });
		assert.ok(!html.includes("Enfileirar"));
		assert.ok(!html.includes("Interromper"));
		assert.ok(!html.includes("Mais opções de envio"));
	}
});

function dictationView(over: Partial<NonNullable<React.ComponentProps<typeof ChatComposer>["dictation"]>> = {}) {
	return { supported: true, phase: "idle" as const, preview: "", elapsedMs: 0, start: () => {}, stop: () => {}, cancel: () => {}, ...over };
}

function buttonTag(html: string, label: string): string {
	const match = html.match(new RegExp("<button[^>]*aria-label=\"" + label + "\"[^>]*>"));
	assert.ok(match, "botão " + label + " ausente");
	return match[0];
}

function count(html: string, needle: string): number {
	return html.split(needle).length - 1;
}

test("sem run e vazio: o botão principal é Ditar, sem mic separado nem Enviar", () => {
	const html = render({ dictation: dictationView() });
	const mic = buttonTag(html, "Ditar");
	assert.ok(mic.includes(" bg-(--bot-accent,var(--primary)) "));
	assert.ok(mic.includes("size-8"));
	assert.equal(count(html, 'aria-label="Ditar"'), 1);
	assert.ok(!html.includes("Enviar mensagem"));
	assert.ok(!html.includes('aria-label="Parar"'));
});

test("sem run e com texto: vira Enviar, sem Ditar", () => {
	const html = render({ dictation: dictationView(), initialText: "oi" });
	assert.ok(buttonTag(html, "Enviar mensagem").includes(" bg-(--bot-accent,var(--primary)) "));
	assert.ok(!html.includes('aria-label="Ditar"'));
});

test("run ativo e vazio: Parar + mic separado secondary à esquerda", () => {
	const html = render({ runActive: true, onStop: () => {}, dictation: dictationView() });
	assert.ok(html.includes('aria-label="Parar"'));
	assert.match(buttonTag(html, "Ditar"), / bg-secondary /);
	assert.ok(html.indexOf('aria-label="Ditar"') < html.indexOf('aria-label="Parar"'));
});

test("run ativo com texto: mic separado + Enviar", () => {
	const html = render({ runActive: true, dictation: dictationView(), initialText: "oi" });
	assert.match(buttonTag(html, "Ditar"), / bg-secondary /);
	assert.ok(html.includes('aria-label="Enviar mensagem"'));
});

test("ditado indisponível: sem mic em nenhum estado", () => {
	for (const runActive of [true, false]) {
		assert.ok(!render({ runActive, dictation: dictationView({ supported: false }) }).includes("Ditar"));
		assert.ok(!render({ runActive }).includes("Ditar"), "SSR sem navegador: oculto");
	}
});

test("gravando sem run: Parar ditado com barras animadas, sem indicador gravando", () => {
	const html = render({ dictation: dictationView({ phase: "recording", preview: "olá mundo", elapsedMs: 65_000 }) });
	assert.match(buttonTag(html, "Parar ditado"), /aria-pressed="true"/);
	assert.ok(html.includes('data-slot="animated-audio-lines"'));
	assert.ok(!html.includes("1:05"), "sem tempo decorrido");
	assert.ok(!html.includes("bg-destructive"), "sem bolinha pulsante");
});

test("gravando com run ativo: mic separado também anima as barras", () => {
	const html = render({ runActive: true, onStop: () => {}, dictation: dictationView({ phase: "recording" }) });
	assert.match(buttonTag(html, "Parar ditado"), / bg-secondary /);
	assert.ok(html.includes('data-slot="animated-audio-lines"'));
	assert.ok(html.includes('aria-label="Parar"'));
});

test("prévia fica dentro do campo, muted + itálico, e fora do valor do textarea", () => {
	const html = render({ dictation: dictationView({ phase: "recording", preview: "só prévia" }), initialText: "oi" });
	const field = html.slice(html.indexOf('data-slot="composer-field"'));
	const overlay = field.match(/<div[^>]*data-slot="dictation-preview"[^>]*>.*?<\/div>/);
	assert.ok(overlay, "overlay ausente");
	assert.ok(overlay[0].includes("só prévia"));
	assert.ok(overlay[0].includes("text-muted-foreground") && overlay[0].includes("italic"));
	assert.ok(overlay[0].includes("text-transparent"), "texto digitado transparente no overlay");
	assert.ok(field.indexOf("<textarea") < field.indexOf('data-slot="dictation-preview"'));
	assert.ok(!/<textarea[^>]*>[^<]*só prévia/.test(html));
});

test("gravando sem prévia mostra Ouvindo…; transcrevendo mantém a prévia pulsando", () => {
	assert.ok(render({ dictation: dictationView({ phase: "recording" }) }).includes("Ouvindo…"));
	const html = render({ dictation: dictationView({ phase: "transcribing", preview: "texto parcial" }) });
	assert.ok(html.includes("texto parcial") && html.includes("animate-pulse"));
	assert.ok(!html.includes('aria-label="Transcrevendo"'), "sem spinner separado");
	assert.match(buttonTag(html, "Ditar"), /disabled/);
});

test("sem ditado ativo não há overlay de prévia", () => {
	assert.ok(!render({ dictation: dictationView() }).includes('data-slot="dictation-preview"'));
});
