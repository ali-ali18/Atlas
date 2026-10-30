import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";

import { DevSessionCardView } from "@/components/ai-elements/dev-session/dev-session-card";
import { NotificationsSettingsView } from "@/components/settings/sections/notifications";
import { secretLimitError } from "@/components/settings/dev-environments-state";
import { filterCatalogItems } from "@/components/ui/templates/template-4/marketplace/catalog-state";
import { FIXTURE_SESSION_ID, devSessionFixtureEvents } from "@/lib/dev-session/fixture";
import { applyDevSessionEvent, devPillLabel, type DevSessionMap } from "@/lib/dev-session/reducer";
import { accountDisplayLabel } from "@/lib/connector-accounts";
import type { UiLocale } from "@/lib/i18n/locales";
import { loadMessages } from "@/lib/i18n/messages";
import { I18nProvider } from "@/lib/i18n/provider";
import { createTranslator } from "@/lib/i18n/translator";

Object.assign(globalThis, { React });

/** Como o servidor desenha: `renderToString` com o provider do idioma e nenhum tradutor "ativo" (só existe no navegador). */
async function ssr(locale: UiLocale, node: React.ReactNode): Promise<string> {
	return renderToString(
		<I18nProvider locale={locale} messages={await loadMessages(locale)}>
			{node}
		</I18nProvider>,
	);
}

function stoppedSession() {
	const start = 1_000_000;
	let map: DevSessionMap = {};
	devSessionFixtureEvents(start, "done").forEach((event, index) => {
		map = applyDevSessionEvent(map, event, { at: start + index * 500 });
	});
	return map[FIXTURE_SESSION_ID]!;
}

test("SSR em en-US: estado das notificações e 'último uso' saem em inglês, não em pt-BR", async () => {
	const noop = () => {};
	const now = Date.parse("2026-11-01T12:00:00Z");
	const html = await ssr(
		"en-US",
		<NotificationsSettingsView currentDeviceId="d1" devices={[{ id: "d1", label: "Chrome", createdAt: "", lastUsedAt: "2026-11-01T11:30:00Z", failing: false }]} now={now} onDisable={noop} onEnable={noop} onRemove={noop} onTest={noop} state="denied" />,
	);
	assert.match(html, /Notifications are blocked in this browser/);
	assert.match(html, /30 min ago/);
	assert.doesNotMatch(html, /bloquead|há 30/);
});

test("SSR em es-ES: cartão da sessão de código usa o rótulo de estado do idioma", async () => {
	const view = stoppedSession();
	const html = await ssr("es-ES", <DevSessionCardView now={view.startedAt + 9_999_999} view={view} />);
	assert.match(html, /Detenida · \d/);
	assert.doesNotMatch(html, /Parada/);
	const en = createTranslator("en-US", await loadMessages("en-US"));
	assert.match(devPillLabel(view, view.startedAt + 5000, en), /^Stopped · /);
});

test("conta numerada e limite de segredos usam o tradutor recebido", async () => {
	const es = createTranslator("es-ES", await loadMessages("es-ES"));
	const accounts = [{ id: "a", accountLabel: null }, { id: "b", accountLabel: null }];
	assert.match(accountDisplayLabel(accounts[1]!, accounts, es) ?? "", /^Cuenta 2$/);
	const names = Array.from({ length: 31 }, (_, index) => `K${index}`);
	assert.match(secretLimitError(names, [], es) ?? "", /^Como máximo 30 secretos por entorno$/);
});

test("busca do catálogo acha pelo nome da categoria no idioma da tela (e ainda pelo nome em pt-BR)", async () => {
	const en = createTranslator("en-US", await loadMessages("en-US"));
	const item = { name: "Roblox", description: "", author: "ana", tags: [], category: "games" };
	assert.equal(filterCatalogItems([item], "games", "", en).length, 1);
	assert.equal(filterCatalogItems([item], "jogos", "", en).length, 1);
	assert.equal(filterCatalogItems([item], "juegos", "", createTranslator("es-ES", await loadMessages("es-ES"))).length, 1);
	assert.equal(filterCatalogItems([item], "games", "").length, 0);
});
