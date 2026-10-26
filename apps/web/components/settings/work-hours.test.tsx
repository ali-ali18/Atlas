import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_WORK_HOURS, readWorkHours, type AccountSettingsResponse } from "@workspace/shared";
import { applyOptimisticPatch, commitSettingsChange } from "./account-settings-state";
import {
	nextWorkHours,
	resolveWorkHoursEdit,
	WORK_HOURS_DAYS_ERROR,
	WORK_HOURS_ORDER_ERROR,
	WorkHoursSettingsView,
} from "./sections/work-hours";

Object.assign(globalThis, { React });

const noop = () => {};

function view(props: Partial<React.ComponentProps<typeof WorkHoursSettingsView>> = {}) {
	return renderToStaticMarkup(
		<WorkHoursSettingsView onChange={noop} status="idle" value={DEFAULT_WORK_HOURS} {...props} />,
	);
}

test("linha Horário de trabalho: dois horários e sete dias, segunda a sexta marcados por padrão", () => {
	const html = view();
	assert.match(html, />Horário de trabalho</);
	assert.match(html, /aria-label="Início do expediente"[^>]*value="08:00"/);
	assert.match(html, /aria-label="Fim do expediente"[^>]*value="18:00"/);
	for (const day of ["Segunda", "Terça", "Quarta", "Quinta", "Sexta"]) assert.match(html, new RegExp(`aria-label="${day}"[^>]*aria-pressed="true"`));
	for (const day of ["Sábado", "Domingo"]) assert.match(html, new RegExp(`aria-label="${day}"[^>]*aria-pressed="false"`));
});

test("erro local aparece; a busca pode esconder o grupo; desabilitado trava os campos", () => {
	assert.match(view({ localError: WORK_HOURS_ORDER_ERROR }), /role="alert"[^>]*>O início precisa/);
	assert.equal(view({ isVisible: (id) => id !== "geral.horario" }), "");
	assert.match(view({ disabled: true }), /disabled=""/);
});

test("edição: horário novo e dia ligado/desligado viram o valor completo; inválido não salva", () => {
	assert.deepEqual(nextWorkHours(DEFAULT_WORK_HOURS, { start: "09:30" }), { ok: true, value: { start: "09:30", end: "18:00", days: [1, 2, 3, 4, 5] } });
	assert.deepEqual(nextWorkHours(DEFAULT_WORK_HOURS, { toggleDay: 6 }), { ok: true, value: { start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5, 6] } });
	assert.deepEqual(nextWorkHours(DEFAULT_WORK_HOURS, { toggleDay: 5 }), { ok: true, value: { start: "08:00", end: "18:00", days: [1, 2, 3, 4] } });
	assert.deepEqual(nextWorkHours(DEFAULT_WORK_HOURS, { start: "19:00" }), { ok: false, error: WORK_HOURS_ORDER_ERROR });
	assert.deepEqual(nextWorkHours({ start: "08:00", end: "18:00", days: [1] }, { toggleDay: 1 }), { ok: false, error: WORK_HOURS_DAYS_ERROR });
});

function accountView(workHours?: unknown): AccountSettingsResponse {
	return {
		config: workHours ? { v: 1, general: { workHours } } : { v: 1 },
		effective: { general: { defaultBotLanguage: { value: "pt-BR", source: "default" }, timezone: { value: undefined, source: "default" } } },
		settings: { sandboxAutoStart: true },
		capabilities: { isOwner: true, openrouterKey: true },
	} as unknown as AccountSettingsResponse;
}

test("conta antiga sem workHours mostra o padrão", () => {
	assert.deepEqual(readWorkHours(accountView().config), DEFAULT_WORK_HOURS);
});

test("persistência: salvar aparece na hora (otimista) e vai no PATCH como general.workHours", async () => {
	const next = { start: "09:00", end: "17:00", days: [1, 2, 3] };
	const optimistic = applyOptimisticPatch(accountView(), { general: { workHours: next } });
	assert.deepEqual(readWorkHours(optimistic.config), next);
	const sent: unknown[] = [];
	const result = await commitSettingsChange({
		view: accountView(),
		patch: { general: { workHours: next } },
		send: async (input) => {
			sent.push(input);
			return accountView(next);
		},
		onOptimistic: noop,
	});
	assert.deepEqual(sent, [{ config: { general: { workHours: next } } }]);
	assert.equal(result.ok, true);
	assert.deepEqual(readWorkHours(result.view.config), next);
});

test("fluxo do container: início depois do fim não salva e mostra o erro; o próximo valor válido salva e limpa", () => {
	const invalid = resolveWorkHoursEdit(DEFAULT_WORK_HOURS, { start: "19:00" });
	assert.deepEqual(invalid, { save: null, error: WORK_HOURS_ORDER_ERROR });
	// o erro do container chega à tela com role=alert
	assert.match(view({ localError: invalid.error }), /role="alert"[^>]*>O início precisa ser antes do fim\./);
	const valid = resolveWorkHoursEdit(DEFAULT_WORK_HOURS, { start: "09:00" });
	assert.deepEqual(valid, { save: { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] }, error: null });
	assert.doesNotMatch(view({ localError: valid.error }), /role="alert"/);
	assert.deepEqual(resolveWorkHoursEdit({ start: "08:00", end: "18:00", days: [1] }, { toggleDay: 1 }), { save: null, error: WORK_HOURS_DAYS_ERROR });
});

test("texto do expediente só promete o que é verdade", () => {
	assert.match(view(), /Seu expediente, no fuso da conta\. O bot vai usar isso para não te chamar fora dele\./);
});
