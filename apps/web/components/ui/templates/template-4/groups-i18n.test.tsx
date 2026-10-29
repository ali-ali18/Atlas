import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { loadMessages } from "@/lib/i18n/messages";
import { I18nProvider } from "@/lib/i18n/provider";
import { createTranslator } from "@/lib/i18n/translator";
import { avatarColorName } from "./avatar-color-name";
import type { Agent } from "./data";
import { MobileCreateBot } from "./mobile-create-bot";
import { NewChatTo, defaultGroupName, recipientRows } from "./new-group";
import { PrimaryBotBadge } from "./primary-bot-badge";

Object.assign(globalThis, { React });

const agent = (id: string, name: string): Agent => ({ id, name, color: "#2196f3", snippet: "", time: "" });

async function wrap(locale: "en-US" | "es-ES", node: React.ReactNode) {
	return renderToStaticMarkup(<I18nProvider locale={locale} messages={await loadMessages(locale)}>{node}</I18nProvider>);
}

test("novo chat e grupo no idioma da tela", async () => {
	const en = await wrap("en-US", <NewChatTo agents={[agent("a", "Ana"), agent("b", "Bia")]} onCancel={() => {}} onNewBot={() => {}} onOpenBot={() => {}} onSend={async () => true} />);
	assert.match(en, /Create new Bot/);
	assert.match(en, /Create group chat/);
	assert.match(en, /To:/);
	assert.doesNotMatch(en, /Criar|Para:/);
	const es = await wrap("es-ES", <NewChatTo agents={[agent("a", "Ana")]} initialGroupMode onCancel={() => {}} onNewBot={() => {}} onOpenBot={() => {}} onSend={async () => true} />);
	assert.match(es, /Mensaje para el grupo/);
});

test("nome padrão do grupo usa a lista do idioma e a busca acha o texto traduzido", async () => {
	const en = createTranslator("en-US", await loadMessages("en-US"));
	assert.equal(defaultGroupName(["Ana", "Bia", "Caio"], en), "Ana, Bia, and Caio");
	assert.equal(defaultGroupName([], en), "Group");
	assert.equal(defaultGroupName(["Ana", "Bia"]), "Ana e Bia");
	assert.deepEqual(recipientRows([], [], "create group", false, en).map((row) => row.kind), ["new-group"]);
});

test("Bot principal, criar bot e cores no idioma da tela", async () => {
	assert.match(await wrap("en-US", <PrimaryBotBadge show size={36}>x</PrimaryBotBadge>), /aria-label="Main Bot"/);
	const create = await wrap("es-ES", <MobileCreateBot onCancel={() => {}} onCreate={async () => true} />);
	assert.match(create, /Crear nuevo Bot/);
	assert.match(create, /aria-label="Negro"/);
	assert.equal(avatarColorName("#FF6700", createTranslator("en-US", await loadMessages("en-US")).t), "Orange");
});
