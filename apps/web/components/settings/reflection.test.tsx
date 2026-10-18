import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountSettingsResponse } from "@workspace/shared";
import { applyOptimisticPatch } from "./account-settings-state";
import { memoryOptions, reflectionStatusLabel, whenLabel } from "./reflection-state";
import { ReflectionSettingsView } from "./sections/reflection";

Object.assign(globalThis, { React });

const NOW = new Date("2026-10-15T15:00:00Z");
const SP = "America/Sao_Paulo";
const noop = () => {};

const last = (over: Record<string, unknown> = {}) => ({
	id: "r",
	trigger: "scheduled" as const,
	status: "done" as const,
	summary: null,
	important: false,
	detail: null,
	finishedAt: "2026-10-15T09:32:00Z",
	startedAt: "2026-10-15T09:30:00Z",
	changeCount: 0,
	...over,
});

test("quando foi: hoje, ontem ou data, no fuso da conta", () => {
	assert.equal(whenLabel("2026-10-15T09:32:00Z", NOW, SP), "hoje 06:32");
	assert.equal(whenLabel("2026-10-14T09:32:00Z", NOW, SP), "ontem 06:32");
	assert.equal(whenLabel("2026-10-10T09:32:00Z", NOW, SP), "10/10 06:32");
});

test("linha de estado: em andamento, nunca rodou, resultado da última", () => {
	assert.equal(reflectionStatusLabel(null, NOW), "");
	assert.equal(reflectionStatusLabel({ active: true, last: null, timezone: SP }, NOW), "Refletindo agora…");
	assert.equal(reflectionStatusLabel({ active: false, last: null, timezone: SP }, NOW), "Ainda não rodou.");
	assert.equal(reflectionStatusLabel({ active: false, last: last(), timezone: SP }, NOW), "Última: hoje 06:32 · nada relevante");
	assert.equal(reflectionStatusLabel({ active: false, last: last({ changeCount: 3 }), timezone: SP }, NOW), "Última: hoje 06:32 · 3 alterações");
	assert.equal(reflectionStatusLabel({ active: false, last: last({ important: true }), timezone: SP }, NOW), "Última: hoje 06:32 · achou algo importante");
	assert.equal(reflectionStatusLabel({ active: false, last: last({ status: "skipped", detail: "sem atividade nova" }), timezone: SP }, NOW), "Última: hoje 06:32 · sem novidades");
	assert.equal(reflectionStatusLabel({ active: false, last: last({ status: "failed" }), timezone: SP }, NOW), "Última: hoje 06:32 · falhou");
	assert.equal(reflectionStatusLabel({ active: false, last: last({ status: "failed", detail: "modelo de manutenção indisponível" }), timezone: SP }, NOW), "Última: hoje 06:32 · falhou · modelo de manutenção indisponível");
	assert.equal(reflectionStatusLabel({ active: false, last: last({ status: "failed", detail: "OPENROUTER_API_KEY não configurada no worker" }), timezone: SP }, NOW), "Última: hoje 06:32 · falhou · sem chave OpenRouter no servidor");
});

const render = (over: Partial<Parameters<typeof ReflectionSettingsView>[0]> = {}) =>
	renderToStaticMarkup(
		<ReflectionSettingsView
			busy={false}
			enabled={false}
			hasPrimary
			memoryChars={6000}
			memoryUsed={3100}
			onMemoryChars={noop}
			onRunNow={noop}
			onTime={noop}
			onToggle={noop}
			status={null}
			now={NOW}
			time="06:00"
			timeZone={SP}
			{...over}
		/>,
	);

test("desligada: só o interruptor e Refletir agora; sem horário", () => {
	const html = render();
	assert.match(html, /Reflexão diária/);
	assert.match(html, /role="switch"[^>]*aria-checked="false"|aria-checked="false"[^>]*role="switch"/);
	assert.doesNotMatch(html, /settings-reflection-time/);
	assert.match(html, /Refletir agora/);
});

test("ligada: mostra o horário no fuso da conta e o estado da última", () => {
	const html = render({ enabled: true, time: "06:30", status: { active: false, last: last(), timezone: SP } });
	assert.match(html, /id="settings-reflection-time"[^>]*type="time"|type="time"[^>]*id="settings-reflection-time"/);
	assert.match(html, /value="06:30"/);
	assert.match(html, /São Paulo \(GMT-3\)/);
	assert.match(html, /Última: hoje 06:32 · nada relevante/);
});

test("em andamento desabilita Refletir agora; sem bot principal esconde e avisa", () => {
	assert.match(render({ status: { active: true, last: null, timezone: SP } }), /<button[^>]*disabled[^>]*>Refletir agora/);
	const none = render({ hasPrimary: false });
	assert.match(none, /Defina um bot principal para usar/);
	assert.doesNotMatch(none, /Refletir agora/);
});

test("busca de configurações pode esconder o grupo", () => {
	assert.equal(render({ isVisible: () => false }), "");
});

test("escolha aparece na hora (otimista) na config da conta", () => {
	const view = { config: { v: 1 }, effective: {}, settings: {} } as unknown as AccountSettingsResponse;
	const next = applyOptimisticPatch(view, { reflection: { enabled: true, time: "07:15" } });
	assert.deepEqual(next.config.reflection, { enabled: true, time: "07:15" });
	const off = applyOptimisticPatch(next, { reflection: { enabled: false } });
	assert.deepEqual(off.config.reflection, { enabled: false, time: "07:15" });
});

test("memória do bot principal: opções com caracteres e uso atual", () => {
	const html = render();
	assert.match(html, /Memória do bot principal/);
	assert.match(html, /Em uso: 3.100 de 6.000 caracteres/);
	assert.match(html, /Grande · 6.000/);
	assert.match(render({ memoryUsed: null }), /Quanto o bot principal pode guardar/);
	assert.doesNotMatch(render({ hasPrimary: false }), /Memória do bot principal/);
});

test("opções: Normal, Grande e Muito grande; valor fora da lista vira Personalizado", () => {
	assert.deepEqual(memoryOptions(6000).map((o) => o.label), ["Normal · 2.200", "Grande · 6.000", "Muito grande · 12.000"]);
	assert.equal(memoryOptions(8000)[0]?.label, "Personalizado · 8.000");
});
