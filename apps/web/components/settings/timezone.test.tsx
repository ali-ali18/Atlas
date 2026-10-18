import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountSettingsResponse } from "@workspace/shared";
import { applyOptimisticPatch, commitSettingsChange } from "./account-settings-state";
import { TimezoneSettingsView } from "./sections/timezone";
import {
	detectedTimeZone,
	filterTimeZones,
	listTimeZones,
	shownTimeZone,
	timeZoneCity,
	timeZoneLabel,
} from "./timezone-state";

Object.assign(globalThis, { React });

const noop = () => {};

test("lista de fusos: IANA válidos, ordenados, com UTC e São Paulo", () => {
	const zones = listTimeZones();
	assert.ok(zones.includes("America/Sao_Paulo"));
	assert.ok(zones.includes("UTC"));
	assert.deepEqual([...zones].sort((a, b) => a.localeCompare(b)), zones);
});

test("rótulo: cidade e deslocamento; cidade sem sublinhado", () => {
	assert.equal(timeZoneCity("America/Argentina/Buenos_Aires"), "Buenos Aires");
	assert.equal(timeZoneLabel("America/Sao_Paulo", new Date("2026-10-14T12:00:00Z")), "São Paulo (GMT-3)");
	assert.match(timeZoneLabel("UTC", new Date("2026-10-14T12:00:00Z")), /^UTC \(GMT/);
});

test("busca de fuso: por cidade, região e id, sem acento nem caixa", () => {
	const zones = ["America/Sao_Paulo", "America/Manaus", "Europe/Lisbon", "Asia/Tokyo"];
	assert.deepEqual(filterTimeZones(zones, "sao paulo"), ["America/Sao_Paulo"]);
	assert.deepEqual(filterTimeZones(zones, "LISBON"), ["Europe/Lisbon"]);
	assert.deepEqual(filterTimeZones(zones, "america"), ["America/Sao_Paulo", "America/Manaus"]);
	assert.deepEqual(filterTimeZones(zones, "zzz"), []);
	assert.deepEqual(filterTimeZones(zones, "  "), zones);
});

test("sem escolha da conta vale o fuso do navegador (automático); com escolha vale a escolha", () => {
	assert.deepEqual(shownTimeZone(undefined, "Europe/Lisbon"), { zone: "Europe/Lisbon", auto: true });
	assert.deepEqual(shownTimeZone("Asia/Tokyo", "Europe/Lisbon"), { zone: "Asia/Tokyo", auto: false });
	assert.deepEqual(shownTimeZone("lixo", "Europe/Lisbon"), { zone: "Europe/Lisbon", auto: true });
	assert.deepEqual(shownTimeZone(undefined, undefined), { zone: "America/Sao_Paulo", auto: true });
	assert.ok(detectedTimeZone() === undefined || typeof detectedTimeZone() === "string");
});

function view(props: Partial<React.ComponentProps<typeof TimezoneSettingsView>> = {}) {
	return renderToStaticMarkup(
		<TimezoneSettingsView detected="America/Sao_Paulo" onChange={noop} status="idle" value={undefined} {...props} />,
	);
}

test("linha Fuso horário: grupo Agendamentos, valor atual no gatilho e 'automático' sem escolha", () => {
	const html = view();
	assert.match(html, /<h3[^>]*>Agendamentos<\/h3>/);
	assert.match(html, />Fuso horário</);
	assert.match(html, /São Paulo \(GMT-3\)/);
	assert.match(html, /· automático/);
	const chosen = view({ value: "Asia/Tokyo" });
	assert.match(chosen, /Tokyo \(GMT\+9\)/);
	assert.doesNotMatch(chosen, /automático/);
});

test("linha Fuso horário: erro ao salvar aparece; a busca pode esconder a linha", () => {
	assert.match(view({ status: "error", saveError: "Informe um fuso horário válido." }), /role="alert"[^>]*>Informe um fuso/);
	assert.equal(view({ isVisible: (id) => id !== "geral.fuso" }), "");
	assert.match(view({ disabled: true }), /disabled=""/);
});

function accountView(timezone?: string): AccountSettingsResponse {
	return {
		config: { v: 1 },
		effective: { general: { defaultBotLanguage: { value: "pt-BR", source: "default" }, timezone: { value: timezone, source: timezone ? "user" : "default" } } },
		settings: { sandboxAutoStart: true },
		capabilities: { isOwner: true, openrouterKey: true },
	} as unknown as AccountSettingsResponse;
}

test("persistência: escolher um fuso aparece na hora (otimista) e vai no PATCH como general.timezone", async () => {
	const optimistic = applyOptimisticPatch(accountView(), { general: { timezone: "Asia/Tokyo" } });
	assert.deepEqual(optimistic.effective.general.timezone, { value: "Asia/Tokyo", source: "user" });
	const sent: unknown[] = [];
	const shown: AccountSettingsResponse[] = [];
	const result = await commitSettingsChange({
		view: accountView(),
		patch: { general: { timezone: "Asia/Tokyo" } },
		send: async (input) => {
			sent.push(input);
			return accountView("Asia/Tokyo");
		},
		onOptimistic: (next) => shown.push(next),
	});
	assert.deepEqual(sent, [{ config: { general: { timezone: "Asia/Tokyo" } } }]);
	assert.equal(shown[0]?.effective.general.timezone.value, "Asia/Tokyo");
	assert.equal(result.ok, true);
	assert.equal(result.view.effective.general.timezone.value, "Asia/Tokyo");
});

test("persistência: voltar ao automático manda null; falha do servidor desfaz e mostra o erro", async () => {
	const sent: unknown[] = [];
	await commitSettingsChange({
		view: accountView("Asia/Tokyo"),
		patch: { general: { timezone: null } },
		send: async (input) => {
			sent.push(input);
			return accountView();
		},
	});
	assert.deepEqual(sent, [{ config: { general: { timezone: null } } }]);
	const failed = await commitSettingsChange({
		view: accountView("Asia/Tokyo"),
		patch: { general: { timezone: "Europe/Lisbon" } },
		send: async () => {
			throw { status: 400, message: "Informe um fuso horário válido (ex.: America/Sao_Paulo)." };
		},
	});
	assert.equal(failed.ok, false);
	assert.equal(failed.view.effective.general.timezone.value, "Asia/Tokyo", "voltou ao anterior");
	assert.ok(!failed.ok && /fuso horário válido/.test(failed.error));
});
