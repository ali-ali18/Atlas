import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { loadMessages } from "@/lib/i18n/messages";
import { I18nProvider } from "@/lib/i18n/provider";
import { createTranslator } from "@/lib/i18n/translator";
import { durationLabel, hostToolLabel, levelDescription, levelLabel, remainingLabel } from "./autonomy-copy";
import { AutonomyValidityButton } from "./autonomy-validity-button";

Object.assign(globalThis, { React });

const NOW = new Date("2026-10-29T12:00:00Z");

test("rótulos da autonomia seguem o idioma e o pt-BR continua igual ao shared", async () => {
	const en = createTranslator("en-US", await loadMessages("en-US"));
	const es = createTranslator("es-ES", await loadMessages("es-ES"));
	assert.equal(levelLabel("balanced", en), "Balanced");
	assert.equal(levelLabel("always_ask", es), "Preguntar siempre");
	assert.equal(levelLabel("autonomous"), "Autônomo");
	assert.match(levelDescription("autonomous", en), /^Acts on its own/);
	assert.equal(durationLabel("7d", en), "7 days");
	assert.equal(hostToolLabel("propose_skill_delete", en), "Delete a skill");
	assert.equal(hostToolLabel("mcp__x__y", en), undefined);
});

test("validade restante: horas e dias com plural do idioma", async () => {
	const en = createTranslator("en-US", await loadMessages("en-US"));
	const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
	assert.equal(remainingLabel(at(30 * 60_000), NOW, en), "less than 1 hour");
	assert.equal(remainingLabel(at(5 * 3_600_000), NOW, en), "5 hours");
	assert.equal(remainingLabel(at(3_600_000), NOW, en), "1 hour");
	assert.equal(remainingLabel(at(6 * 86_400_000), NOW, en), "6 days");
	assert.equal(remainingLabel(at(-5), NOW), "menos de 1 hora");
	assert.equal(remainingLabel(at(6 * 86_400_000), NOW), "6 dias");
});

test("botão de validade no idioma da tela", async () => {
	const html = renderToStaticMarkup(
		<I18nProvider locale="en-US" messages={await loadMessages("en-US")}>
			<AutonomyValidityButton active={false} onChange={() => {}} value="forever" />
		</I18nProvider>,
	);
	assert.match(html, /aria-label="For how long"/);
	assert.doesNotMatch(html, /Por quanto tempo/);
});
