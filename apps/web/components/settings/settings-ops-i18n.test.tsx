import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import type { DiagnosticsView, UsageResponse } from "@workspace/shared";
import { createTranslator } from "@/lib/i18n/translator";
import { loadMessages } from "@/lib/i18n/messages";
import { renderIn } from "./settings-i18n-render";
import { memoryOptions, reflectionStatusLabel } from "./reflection-state";
import { DiagnosticsSettingsView } from "./sections/diagnostics";
import { ReflectionSettingsView } from "./sections/reflection";
import { TimezoneSettingsView } from "./sections/timezone";
import { UsageSettingsView } from "./sections/usage";
import { WorkHoursSettingsView, nextWorkHours } from "./sections/work-hours";

Object.assign(globalThis, { React });

const noop = () => {};

const diagnostics: DiagnosticsView = {
	generatedAt: "2026-10-15T12:00:00.000Z",
	api: { service: "api", version: "0.1.0-beta", commit: "abc1234", commitShort: "abc1234", startedAt: "2026-10-15T11:00:00.000Z", uptimeSec: 3600, node: "v22" },
	worker: { up: false, version: null, commit: null, commitShort: null, startedAt: null, lastBeatAt: null },
	services: { postgres: { ok: true, ms: 3 }, redis: { ok: false, ms: null, error: "ECONNREFUSED" }, queues: [{ name: "agent-runs", waiting: 1, active: 0, delayed: 0, failed: 2 }] },
	push: { enabled: true, problems: [], subscriptions: 2 },
	sentry: { enabled: false },
	providers: [{ id: "openrouter", label: "OpenRouter", present: true, source: "server" }],
	env: [],
	failures: [{ kind: "routine", id: "r1", label: "Daily", reason: "x", at: "2026-10-15T11:30:00.000Z" }],
	maintenance: [{ kind: "memory-review", lastSuccessAt: null, lastError: null }],
};

test("Diagnóstico em inglês: serviços, fila, uptime e tarefas traduzidos", async () => {
	const html = await renderIn("en-US", <DiagnosticsSettingsView data={diagnostics} error={null} loading={false} onRefresh={noop} webCommit="abc1234" />);
	assert.match(html, /Server status/);
	assert.match(html, /abc1234 · up for 1 h/);
	assert.match(html, /down · ECONNREFUSED/);
	assert.match(html, /0 running · 1 waiting · 2 failed/);
	assert.match(html, /on · 2 devices/);
	assert.match(html, /Memory review/);
	assert.match(html, /No success yet/);
	assert.match(html, /Routine · Daily/);
	assert.doesNotMatch(html, /Estado do servidor|ligada há|Rotina ·/);
});

test("Diagnóstico em espanhol", async () => {
	const html = await renderIn("es-ES", <DiagnosticsSettingsView data={diagnostics} error={null} loading={false} onRefresh={noop} webCommit="abc1234" />);
	assert.match(html, /Estado del servidor/);
	assert.match(html, /2 dispositivos/);
	assert.match(html, /Rutina · Daily/);
});

const totals = { runs: 3, costUsd: 1.5, costUnknownCalls: 1, planCalls: 0, promptTokens: 12000, completionTokens: 3000, cachedTokens: 500 };
const usage: UsageResponse = { period: "7d", tz: "UTC", from: "", to: "", totals, byBot: [{ ...totals, key: "b1", botId: "b1", name: "Ana" }], byModel: [] };

test("Uso em inglês: período, custo parcial, execuções e tokens", async () => {
	const html = await renderIn("en-US", <UsageSettingsView data={usage} error={null} loading={false} onPeriodChange={noop} onRetry={noop} period="7d" />);
	assert.match(html, /Last 7 days/);
	assert.match(html, /US\$ 1\.5000 \(partial cost: 1 call without cost\)/);
	assert.match(html, />3</);
	assert.match(html, /in, .* out, .* cached/);
	assert.match(html, /aria-label="By bot"/);
	assert.doesNotMatch(html, /Por bot|Últimos/);
});

test("Reflexão em inglês e estado da última rodada", async () => {
	const html = await renderIn(
		"en-US",
		<ReflectionSettingsView busy={false} enabled hasPrimary memoryChars={6000} memoryUsed={3100} onMemoryChars={noop} onRunNow={noop} onTime={noop} onToggle={noop} status={null} time="06:00" timeZone="America/Sao_Paulo" />,
	);
	assert.match(html, /Daily reflection/);
	assert.match(html, /aria-label="Reflection time"/);
	assert.match(html, /In use: 3,100 of 6,000 characters\./);
	assert.match(html, /Large · 6,000/);
	const en = createTranslator("en-US", await loadMessages("en-US"));
	const last = { id: "r", trigger: "scheduled" as const, status: "done" as const, summary: null, important: false, detail: null, finishedAt: "2026-10-15T09:32:00Z", startedAt: null, changeCount: 3 };
	assert.equal(reflectionStatusLabel({ active: false, last, timezone: "America/Sao_Paulo" }, new Date("2026-10-15T15:00:00Z"), en), "Last: today 6:32 AM · 3 changes");
	assert.equal(memoryOptions(8000, en)[0]?.label, "Custom · 8,000");
});

test("Expediente: dias e erros no idioma da tela", async () => {
	const html = await renderIn("en-US", <WorkHoursSettingsView localError="The start must be before the end." onChange={noop} status="idle" value={{ start: "08:00", end: "18:00", days: [1, 2] }} />);
	assert.match(html, /aria-label="Monday"/);
	assert.match(html, /aria-label="Work days"/);
	assert.match(html, /The start must be before the end\./);
	const es = createTranslator("es-ES", await loadMessages("es-ES"));
	assert.deepEqual(nextWorkHours({ start: "08:00", end: "18:00", days: [1] }, { toggleDay: 1 }, es), { ok: false, error: "Elige al menos un día." });
});

test("Fuso horário em inglês", async () => {
	const html = await renderIn("en-US", <TimezoneSettingsView detected="America/Sao_Paulo" onChange={noop} status="idle" value={undefined} />);
	assert.match(html, /Scheduling/);
	assert.match(html, /aria-label="Time zone"/);
	assert.match(html, /São Paulo \(GMT-3\) · automatic/);
});
