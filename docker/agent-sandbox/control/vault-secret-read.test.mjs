// C1 da auditoria F9: o valor que o login do Cofre digitou nunca volta ao modelo, nem quando a página troca o tipo do campo
// (botão "mostrar senha": type=password vira text). Chromium real, como os testes vizinhos.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createBrowserActions } from "./browser-actions.mjs";
import { createRefActions } from "./browser-refs.mjs";
import { createBrowserV4 } from "./browser-v4.mjs";
import { launchFixtureBrowser } from "./test-browser.mjs";

const LOGIN = `<!doctype html><html><head><title>Entrar</title></head><body><main><h1>Entrar</h1>
<form action="/entrar" method="post"><label>Usuário <input type="text" name="user" id="u"></label>
<label>Senha <input type="password" name="pw" id="p"></label>
<button type="button" id="show" onclick="document.getElementById('p').type='text'">Mostrar senha</button><button type="submit">Entrar</button></form></main></body></html>`;

const fixtures = await launchFixtureBrowser({ "/login": LOGIN });
after(async () => { await fixtures?.close(); });
const skip = fixtures ? false : "Chromium/playwright-core indisponível";
const SECRET = "Zq9-vault-secret-7731";

async function setup() {
	const page = await fixtures.newPage();
	await page.goto(`${fixtures.base}/login`);
	const actions = createBrowserActions({ getPage: async () => page, loginGuardWaitMs: 300 });
	const refs = createRefActions({ withPageRetry: actions.withPageRetry, clickElement: actions.clickElement });
	actions.setObserver(refs.observeAction);
	const handle = createBrowserV4({
		withPageRetry: actions.withPageRetry, collect: refs.collect, noteDomRefs: () => refs.axStore.setDom(page), browserAct: refs.browserAct, browserWait: refs.browserWait,
		navigate: actions.navigate, listTabs: async () => [], switchTab: async () => {}, closeTab: async () => {}, clickElement: actions.clickElement, locateRef: refs.locateRef,
		workspaceDir: "/tmp", fs: {},
	});
	return { page, actions, refs, handle };
}

test("senha digitada pelo login do Cofre não volta na leitura da página nem se o site trocar o campo para texto", { skip }, async () => {
	const { page, actions, refs, handle } = await setup();
	await refs.browserSnapshot({});
	await actions.browserType({ selector: "#p", text: SECRET, guard: { kind: "password", origin: fixtures.base } });
	await page.click("#show");
	assert.equal(await page.$eval("#p", (el) => el.type), "text");
	const snap = await refs.browserSnapshot({});
	assert.ok(!JSON.stringify(snap).includes(SECRET), `snapshot vazou: ${JSON.stringify(snap).replace(SECRET, "<<VAZOU>>").slice(0, 900)}`);
	const map = await handle("browser.map", {});
	const section = map.data.sections.find((s) => s.kind === "form");
	const read = await handle("browser.read", { section: section.id, from: 1, count: 10 });
	assert.ok(!JSON.stringify([map, read]).includes(SECRET), "mapa/leitura vazou");
});
