import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentSettings } from "../ui/templates/template-4/chat-context-panel/agent-settings";
import type { Agent } from "../ui/templates/template-4/data";

Object.assign(globalThis, { React });

const agent = {
	id: "bot-1",
	name: "Bot",
	color: "#000",
	language: "pt-BR",
	openRouterModel: "chatgpt/luna",
} as unknown as Agent;

test("configurações do bot não têm mais Provedores; ficam modelo, fallback do plano e subagentes", () => {
	const html = renderToStaticMarkup(<AgentSettings agent={agent} onChange={() => {}} />);
	assert.doesNotMatch(html, /Mostrar configurações de provedores/);
	assert.doesNotMatch(html, /atlas-provider-settings/);
	assert.match(html, /Se o limite do plano acabar/);
	assert.match(html, /Modelo dos subagentes/);
});

test("agent-settings.tsx não importa ProvidersSettings", () => {
	const source = readFileSync(
		new URL("../ui/templates/template-4/chat-context-panel/agent-settings.tsx", import.meta.url),
		"utf8",
	);
	assert.doesNotMatch(source, /ProvidersSettings|providers-settings/);
});
