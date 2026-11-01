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

test("a faixa aceita (0,05–20 US$, 1–120 min) aparece na descrição nas 3 línguas", async () => {
	assert.match(await render("pt-BR"), /US\$ 0,05 a 20 e de 1 a 120 minutos/);
	assert.match(await render("en-US"), /US\$ 0\.05 to 20 and 1 to 120 minutes/);
	assert.match(await render("es-ES"), /US\$ 0,05 a 20 y de 1 a 120 minutos/);
});

test("mensagens de valor recusado existem nas 3 línguas", async () => {
	for (const locale of ["pt-BR", "en-US", "es-ES"] as const) {
		const messages = await loadMessages(locale);
		assert.ok(messages["botSettings.engineBudgetUsdInvalid"], locale);
		assert.ok(messages["botSettings.engineBudgetMinutesInvalid"], locale);
	}
});
