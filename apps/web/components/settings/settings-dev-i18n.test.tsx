import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import type { DevEnvironmentView } from "@/lib/atlas-api";
import { createTranslator } from "@/lib/i18n/translator";
import { loadMessages } from "@/lib/i18n/messages";
import { renderIn } from "./settings-i18n-render";
import { addDomains, analyzeSecretsText, approvalOptions, envSummary, networkOptions, savedSecretsLabel, translateCommandError } from "./dev-environments-state";
import { CommandsEditor, DevEnvironmentsListView, SecretsEditor } from "./sections/dev-environments";

Object.assign(globalThis, { React });

const env: DevEnvironmentView = {
	id: "e1", repo: "acme/site", installCommand: null, startCommand: null, testCommand: null, tier: "medium", network: "allowlist",
	allowlist: [], approvalMode: null, commandAllowlist: [], secrets: [{ name: "API_KEY", set: true }],
	createdAt: "2026-10-18T10:00:00.000Z", updatedAt: "2026-10-18T10:00:00.000Z", source: "auto",
} as DevEnvironmentView;
const tr = async (locale: "en-US" | "es-ES") => createTranslator(locale, await loadMessages(locale));

test("Ambientes de código em inglês: lista, resumo e vazio", async () => {
	const html = await renderIn("en-US", <DevEnvironmentsListView environments={[env]} error={null} loading={false} onAdd={() => {}} onChangeDefaultApproval={() => {}} onChangeVerifier={() => {}} onEdit={() => {}} />);
	assert.match(html, /Code environments/);
	assert.match(html, /Command approval/);
	assert.match(html, /detected automatically/);
	assert.match(html, /1 secret/);
	assert.match(html, /Add manually/);
	assert.doesNotMatch(html, /Ambientes|Adicionar|segredo/);
	const empty = await renderIn("es-ES", <DevEnvironmentsListView environments={[]} error={null} loading={false} onAdd={() => {}} onEdit={() => {}} />);
	assert.match(empty, /Creados automáticamente/);
});

test("Editores de comandos e segredos em inglês", async () => {
	const commands = await renderIn("en-US", <CommandsEditor commands={["pnpm test"]} onChange={() => {}} />);
	assert.match(commands, /aria-label="Add allowed command"/);
	assert.match(commands, /aria-label="Remove pnpm test"/);
	const secrets = await renderIn("en-US", <SecretsEditor available busyName={null} errors={[]} existing={[{ name: "DB", set: true }]} onRemoveExisting={() => {}} onTextChange={() => {}} savedCount={2} text="DB=x" />);
	assert.match(secrets, /Import \.env/);
	assert.match(secrets, /DB replaces the value already set\./);
	assert.match(secrets, /2 secrets saved/);
});

test("estado: textos e erros do shared saem no idioma da tela", async () => {
	const en = await tr("en-US");
	const es = await tr("es-ES");
	assert.equal(envSummary({ tier: "small", network: "off", secrets: [] }, en), "Small · 1 GB · No internet after setup");
	assert.equal(networkOptions(en)[0]?.label.endsWith("(default)"), true);
	assert.equal(approvalOptions("ask", es)[0]?.label.startsWith("Predeterminado de la cuenta"), true);
	assert.equal(savedSecretsLabel(1, es), "1 secreto guardado");
	assert.equal(addDomains([], "não é domínio", en).error, "Invalid domain: não");
	assert.deepEqual(analyzeSecretsText("A=1\nB", [], en).errors, ["line 2: missing '='"]);
	assert.equal(analyzeSecretsText("9RUIM=1", [], es).errors[0], "línea 1: el nombre 9RUIM no puede empezar por un número");
	assert.equal(translateCommandError("Comando inválido: rm -rf", en), "Invalid command: rm -rf");
	assert.equal(translateCommandError("outra coisa", en), "outra coisa");
});
