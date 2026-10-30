import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Command, CommandList } from "@workspace/ui/components/command";

import { ProviderCallbackView } from "@/components/providers/provider-callback-view";
import { ProviderGroup, chatgptGroupMessage } from "@/components/model-picker/provider-model-list";
import { ProviderPickerOptions } from "@/components/model-picker/provider-picker-options";
import { AvatarStatus } from "@/components/ui/templates/template-4/avatar-status";
import {
	deleteBotFailureMessage,
	pinFailureMessage,
	primaryFailureMessage,
	readFailureMessage,
	sectionActionFailureMessage,
} from "@/components/ui/templates/template-4/optimistic-actions";
import type { UiLocale } from "@/lib/i18n/locales";
import { loadMessages } from "@/lib/i18n/messages";
import { I18nProvider } from "@/lib/i18n/provider";
import { createTranslator } from "@/lib/i18n/translator";
import { normalizePickerModels, pickerViaLabel } from "@/lib/provider-model-picker";

Object.assign(globalThis, { React });

async function render(locale: UiLocale, node: React.ReactNode): Promise<string> {
	return renderToStaticMarkup(
		<I18nProvider locale={locale} messages={await loadMessages(locale)}>
			{node}
		</I18nProvider>,
	);
}

const models = normalizePickerModels([{ id: "openai/gpt-4o-mini", name: "Mini", provider: "openai", contextLength: 128000 }]);

test("avisos otimistas da lista de bots seguem o idioma", async () => {
	const en = createTranslator("en-US", await loadMessages("en-US"));
	const es = createTranslator("es-ES", await loadMessages("es-ES"));
	assert.equal(pinFailureMessage("Cookie", "pin", en), "Couldn't pin Cookie. Try again.");
	assert.equal(primaryFailureMessage("Cookie", false, es), "No se pudo quitar a Cookie como principal. Inténtalo de nuevo.");
	assert.equal(readFailureMessage("Cookie", true, en), "Couldn't mark Cookie's conversation as unread.");
	assert.equal(deleteBotFailureMessage("Cookie", es), "No se pudo eliminar a Cookie. Inténtalo de nuevo.");
	assert.equal(sectionActionFailureMessage("rename", en), "Couldn't rename the section. Try again.");
	assert.equal(pinFailureMessage("Cookie", "unpin"), "Não deu para desafixar o Cookie. Tente de novo.");
});

test("ponto de status do avatar traduz o rótulo", async () => {
	const html = await render("en-US", <AvatarStatus label="Group" size={52} unread><i /></AvatarStatus>);
	assert.match(html, /aria-label="Group: unread"/);
	const es = await render("es-ES", <AvatarStatus size={52} working><i /></AvatarStatus>);
	assert.match(es, /aria-label="Trabajando"/);
});

test("página de retorno do login do ChatGPT em en-US e es-ES", async () => {
	const en = await render("en-US", <ProviderCallbackView state="error" hasOpener={false} message="x" />);
	assert.match(en, /Couldn&#x27;t connect/);
	assert.match(en, />Close</);
	assert.match(en, />Back to the app</);
	assert.doesNotMatch(en, /Fechar|Voltar ao app|Não foi possível/);
	const es = await render("es-ES", <ProviderCallbackView state="success" hasOpener email="a@b.c" />);
	assert.match(es, /ChatGPT conectado/);
	assert.match(es, /Ya puedes cerrar esta ventana\./);
});

test("seletor de modelo: grupos, avisos e rótulo 'via' no idioma", async () => {
	const en = await render("en-US", <Command shouldFilter={false}><CommandList><ProviderPickerOptions models={models} value="chatgpt/hidden" query="" available={false} status={null} catalogAvailable={false} onSelect={() => {}} onConnect={() => {}} /></CommandList></Command>);
	assert.match(en, /Current model/);
	assert.match(en, /ChatGPT unavailable\. Check the connection in settings\./);
	assert.match(en, /aria-label="Show OpenRouter models"/);
	assert.doesNotMatch(en, /Modelo atual|Mostrar modelos|indisponível/);
	const es = await render("es-ES", <Command shouldFilter={false}><CommandList><ProviderPickerOptions models={models} value="" query="zzz" available={false} status={null} catalogAvailable={false} onSelect={() => {}} onConnect={() => {}} /></CommandList></Command>);
	assert.match(es, /No se encontró ningún modelo\./);
	const group = await render("es-ES", <ProviderGroup name="OpenRouter" count={2}><span /></ProviderGroup>);
	assert.match(group, /aria-label="Mostrar modelos de OpenRouter"/);
	const en2 = createTranslator("en-US", await loadMessages("en-US"));
	assert.equal(chatgptGroupMessage(null, false, en2), "Connect ChatGPT");
	assert.equal(chatgptGroupMessage({ provider: "chatgpt", status: "connected", accountEmail: null, updatedAt: null, lastLimitAt: null }, false, createTranslator("es-ES", await loadMessages("es-ES"))), "Catálogo no disponible temporalmente.");
	assert.equal(pickerViaLabel("opencode-go/kimi-k3", createTranslator("es-ES", await loadMessages("es-ES"))), "vía OpenCode Go");
});
