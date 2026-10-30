import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import type { ComposioStatusView, ComposioToolkitView } from "@workspace/shared";
import { createTranslator } from "@/lib/i18n/translator";
import { loadMessages } from "@/lib/i18n/messages";
import { renderIn } from "./settings-i18n-render";
import { COMPOSIO_FIRST_PAGE, composioConnectLabel, composioKeyCaption, composioNextPage, composioPageLabel } from "./composio-state";
import { ComposioPagerBar } from "./composio-pager";
import { ComposioSettingsView } from "./sections/composio";

Object.assign(globalThis, { React });

const noop = () => {};
const status = { configured: true, keyHint: "ab12", toolCount: 3, secretBoxReady: true } as ComposioStatusView;
const toolkit = { slug: "trello", name: "Trello", description: "Boards", connected: false, noAuth: true, nativeCatalogId: "trello" } as ComposioToolkitView;
const props = { busy: null, connections: [], onConnect: noop, onDisconnect: noop, onRemoveKey: noop, onSaveKey: noop, onSearch: noop, search: "", toolkits: [toolkit] };
const tr = async (locale: "en-US" | "es-ES") => createTranslator(locale, await loadMessages(locale));

test("Composio em inglês: chave, apps e nota do conector nativo", async () => {
	const html = await renderIn("en-US", <ComposioSettingsView {...props} status={status} />);
	assert.match(html, /Composio key/);
	assert.match(html, /Key saved \(ab12\)\. 3 tools available to the agent\./);
	assert.match(html, /Remove key/);
	assert.match(html, /Add app/);
	assert.match(html, /There is already a native connector/);
	assert.match(html, /No login/);
	assert.match(html, /aria-label="Turn on Trello"/);
	assert.doesNotMatch(html, /Chave|Remover|Sem login/);
});

test("Composio sem chave e paginação em espanhol", async () => {
	const off = await renderIn("es-ES", <ComposioSettingsView {...props} status={{ ...status, configured: false } as ComposioStatusView} />);
	assert.match(off, /Clave de Composio/);
	assert.match(off, /placeholder="Pega la clave"/);
	const pager = composioNextPage(COMPOSIO_FIRST_PAGE, "c2");
	const bar = await renderIn("es-ES", <ComposioPagerBar hasNext={false} onNext={noop} onPrev={noop} pager={pager} totalItems={40} />);
	assert.match(bar, /Página 2 de 2/);
	assert.match(bar, />Anterior</);
});

test("rótulos do Composio por idioma", async () => {
	const en = await tr("en-US");
	assert.equal(composioConnectLabel(false, en), "Connect");
	assert.equal(composioKeyCaption({ ...status, toolCount: 0 } as ComposioStatusView, en), "Key saved (ab12). Connect an app to unlock tools.");
	assert.equal(composioPageLabel(COMPOSIO_FIRST_PAGE, null, 20, en), "Page 1");
});
