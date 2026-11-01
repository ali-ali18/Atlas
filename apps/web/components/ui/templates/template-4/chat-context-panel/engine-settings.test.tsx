import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UiLocale } from "@/lib/i18n/locales";
import { loadMessages } from "@/lib/i18n/messages";
import { I18nProvider } from "@/lib/i18n/provider";
import { BudgetField, EngineSettings } from "./engine-settings";

Object.assign(globalThis, { React });

const field = (invalid: boolean) =>
	renderToStaticMarkup(<BudgetField describedBy="err" id="f" invalid={invalid} label="Orçamento" onCommit={() => true} suffix="US$" value="0,50" />);

test("campo recusado marca aria-invalid e aponta para a mensagem; válido não marca", () => {
	const bad = field(true);
	assert.match(bad, /aria-invalid="true"/);
	assert.match(bad, /aria-describedby="err"/);
	assert.doesNotMatch(field(false), / aria-invalid=| aria-describedby=/);
});

async function render(locale: UiLocale): Promise<string> {
	return renderToStaticMarkup(
		<I18nProvider locale={locale} messages={await loadMessages(locale)}>
			<EngineSettings onChange={() => {}} policyJson={{ engine: "v2" }} />
		</I18nProvider>,
	);
}

test("a descrição diz que o gasto é opcional (vazio = sem limite) e o tempo vai de 1 a 180 min, nas 3 línguas", async () => {
	assert.match(await render("pt-BR"), /vazio = sem limite\) e tempo máximo \(de 1 a 180 minutos, padrão 60\)/);
	assert.match(await render("en-US"), /empty = no limit\) and maximum time \(1 to 180 minutes, default 60\)/);
	assert.match(await render("es-ES"), /vacío = sin límite\) y tiempo máximo \(de 1 a 180 minutos, 60 por defecto\)/);
});

test("mensagens de valor recusado existem nas 3 línguas", async () => {
	for (const locale of ["pt-BR", "en-US", "es-ES"] as const) {
		const messages = await loadMessages(locale);
		assert.ok(messages["botSettings.engineBudgetUsdInvalid"], locale);
		assert.ok(messages["botSettings.engineBudgetMinutesInvalid"], locale);
	}
});

async function renderWith(locale: UiLocale, policyJson: unknown): Promise<string> {
	return renderToStaticMarkup(
		<I18nProvider locale={locale} messages={await loadMessages(locale)}>
			<EngineSettings onChange={() => {}} policyJson={policyJson} />
		</I18nProvider>,
	);
}

test("opção 'Usar também em rotinas e grupos' só aparece com o motor novo e reflete o escopo salvo", async () => {
	// Bot sem escolha mostra o padrão (motor novo, em rotinas e grupos também).
	const byDefault = await renderWith("pt-BR", {});
	assert.match(byDefault, /for="agent-engine-scope".*?role="switch"[^>]*aria-checked="true"/);
	// Quem escolheu o motor novo sem escopo também vale em tudo (decisão do dono, 01/11): a opção vem ligada.
	const chosen = await renderWith("pt-BR", { engine: "v2" });
	assert.match(chosen, /for="agent-engine-scope".*?role="switch"[^>]*aria-checked="true"/);
	const chatOnly = await renderWith("pt-BR", { engine: "v2", engineScope: "chat" });
	assert.match(chatOnly, /Usar também em rotinas e grupos/);
	assert.match(chatOnly, /for="agent-engine-scope".*?role="switch"[^>]*aria-checked="false"/);
	const wide = await renderWith("pt-BR", { engine: "v2", engineScope: "all" });
	assert.match(wide, /for="agent-engine-scope".*?role="switch"[^>]*aria-checked="true"/);
	assert.doesNotMatch(await renderWith("pt-BR", { engine: "v1", engineScope: "all" }), /agent-engine-scope/);
	assert.doesNotMatch(await renderWith("pt-BR", { engine: "v1" }), /agent-engine-scope/);
});

test("a opção do escopo existe nas 3 línguas, sem nomes internos", async () => {
	assert.match(await renderWith("en-US", { engine: "v2" }), /Use also in routines and groups/);
	assert.match(await renderWith("es-ES", { engine: "v2" }), /Usar también en rutinas y grupos/);
	for (const locale of ["pt-BR", "en-US", "es-ES"] as const) {
		const messages = await loadMessages(locale);
		for (const key of ["botSettings.engineScope", "botSettings.engineScopeHelp"] as const) {
			assert.ok(messages[key], `${locale} ${key}`);
			assert.doesNotMatch(messages[key], /engineScope|policyJson|v2|cron|tool/i, `${locale} ${key}`);
		}
	}
});
