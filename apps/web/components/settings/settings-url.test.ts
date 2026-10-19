import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	OPEN_PROVIDER_SETTINGS_EVENT,
	listenForProviderSettings,
	openSettingsModal,
	requestProviderSettings,
} from "./settings-url";

const original = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
	if (original) Object.defineProperty(globalThis, "window", original);
	else delete (globalThis as { window?: unknown }).window;
});

/** `window` mínimo: EventTarget + URL atual + replaceState que atualiza a URL. */
function fakeWindow(search: string) {
	const target = new EventTarget() as EventTarget & Record<string, unknown>;
	const location = { pathname: "/chat", search, hash: "" };
	target.location = location;
	target.history = {
		replaceState: (_state: unknown, _title: string, url: string) => {
			const query = url.slice(location.pathname.length);
			location.search = query.startsWith("?") ? query : "";
		},
	};
	target.dispatchEvent = target.dispatchEvent.bind(target);
	Object.defineProperty(globalThis, "window", { value: target, configurable: true, writable: true });
	return { target, location };
}

test("o pedido de Provedores abre o modal em ?settings=provedores (onde mora o ChatGPT) e preserva o resto da URL", () => {
	const { location } = fakeWindow("?provider=chatgpt&status=ok");
	const stop = listenForProviderSettings();
	requestProviderSettings();
	assert.equal(new URLSearchParams(location.search).get("settings"), "provedores");
	assert.equal(new URLSearchParams(location.search).get("provider"), "chatgpt");
	stop();
});

test("depois de cancelar a escuta o pedido não faz nada", () => {
	const { location } = fakeWindow("");
	listenForProviderSettings()();
	requestProviderSettings();
	assert.equal(location.search, "");
});

test("o nome do evento antigo segue o mesmo (quem já dispara continua funcionando)", () => {
	assert.equal(OPEN_PROVIDER_SETTINGS_EVENT, "atlas:open-provider-settings");
	const { target, location } = fakeWindow("");
	const stop = listenForProviderSettings(target);
	target.dispatchEvent(new Event("atlas:open-provider-settings"));
	assert.equal(location.search, "?settings=provedores");
	stop();
});

test("openSettingsModal escreve só o parâmetro da seção", () => {
	const { location } = fakeWindow("?x=1");
	openSettingsModal("diagnostico");
	assert.equal(new URLSearchParams(location.search).get("settings"), "diagnostico");
	assert.equal(new URLSearchParams(location.search).get("x"), "1");
});

test("openSettingsModal traduz ids antigos (composio, habilidades, provedores) para a seção nova", () => {
	const { location } = fakeWindow("");
	openSettingsModal("composio");
	assert.equal(new URLSearchParams(location.search).get("settings"), "conexoes");
	openSettingsModal("habilidades");
	assert.equal(new URLSearchParams(location.search).get("settings"), "habilidades");
	openSettingsModal("ambientes");
	assert.equal(new URLSearchParams(location.search).get("settings"), "computador");
	openSettingsModal("jev");
	assert.equal(new URLSearchParams(location.search).get("settings"), "revisao");
	openSettingsModal("avancado");
	assert.equal(new URLSearchParams(location.search).get("settings"), "revisao");
	openSettingsModal("nada-disso");
	assert.equal(new URLSearchParams(location.search).get("settings"), "geral");
});
