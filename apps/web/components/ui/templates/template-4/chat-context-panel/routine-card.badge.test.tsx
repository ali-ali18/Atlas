import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoutineRecord } from "@workspace/shared";
import type { Routine } from "../data";
import { RoutineCard } from "./routine-card";
import { recordToUiRoutine } from "./routine-map";

Object.assign(globalThis, { React });

const record = (patch: Partial<RoutineRecord> = {}): RoutineRecord => ({
	id: "r1",
	userId: "u1",
	botId: "b1",
	conversationId: null,
	name: "Resumo da semana",
	prompt: "Resuma a semana",
	model: "",
	enabled: true,
	triggerType: "cron",
	schedule: "0 8 * * 1",
	timezone: "America/Sao_Paulo",
	lastRunAt: null,
	createdAt: "2026-10-14T00:00:00.000Z",
	updatedAt: "2026-10-14T00:00:00.000Z",
	...patch,
});

const html = (routine: Routine) => renderToStaticMarkup(<RoutineCard persisted routine={routine} />);

test("rotina criada pelo bot ganha o selo 'Criada pelo bot' e continua com as ações de sempre", () => {
	const out = html(recordToUiRoutine(record({ createdBy: "bot" })));
	assert.match(out, /data-routine-created-by="bot"/);
	assert.match(out, />Criada pelo bot</);
	assert.match(out, /Mais ações de Resumo da semana/);
	assert.match(out, /role="switch"/);
});

test("rotina do usuário (ou sem o campo) não tem selo", () => {
	assert.doesNotMatch(html(recordToUiRoutine(record({ createdBy: "user" }))), /Criada pelo bot/);
	assert.doesNotMatch(html(recordToUiRoutine(record())), /Criada pelo bot/);
});

test("o selo vale para qualquer gatilho (intervalo, lembrete único)", () => {
	assert.equal(recordToUiRoutine(record({ createdBy: "bot", triggerType: "interval", schedule: null, interval: { everyMinutes: 60 } })).createdBy, "bot");
	assert.equal(recordToUiRoutine(record({ createdBy: "bot", triggerType: "once", schedule: null, once: { runAt: "2026-12-01T12:00:00.000Z" } })).createdBy, "bot");
});
