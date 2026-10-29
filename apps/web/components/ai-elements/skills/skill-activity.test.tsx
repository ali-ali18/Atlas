import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SkillActivityCard, skillActivityText } from "./skill-activity";

Object.assign(globalThis, { React });

test("texto sem gênero errado, sem chave interna e sem número de versão", () => {
	assert.equal(skillActivityText("updated", "Resumo semanal"), "Habilidade “Resumo semanal” atualizada");
	assert.equal(skillActivityText("created", "Resumo semanal"), "Habilidade “Resumo semanal” criada e ativa");
	assert.equal(skillActivityText("deleted"), "Habilidade apagada");
});

test("não mostra slug nem (vN) mesmo quando o evento traz os dois", () => {
	const html = renderToStaticMarkup(
		<SkillActivityCard action="updated" capabilityKey="resumo-semanal" title="Resumo semanal" versionNumber={3} />,
	);
	assert.match(html, /Habilidade “Resumo semanal” atualizada/);
	assert.doesNotMatch(html, /resumo-semanal|v3/);
});
