import { test, after } from "node:test";
import assert from "node:assert/strict";
import { launchFixtureBrowser } from "./test-browser.mjs";
import { classifyPageState, readPageState, PAGE_STATES } from "./page-state.mjs";

test("classifyPageState: prioridade desafio > erro > login > consentimento > carregando > ok", () => {
	const all = { challengeFrame: true, status: 503, hasPassword: true, consent: true, readyState: "loading", textLength: 500, interactiveCount: 3 };
	assert.equal(classifyPageState(all).state, "challenge");
	assert.equal(classifyPageState({ ...all, challengeFrame: false }).state, "error");
	assert.equal(classifyPageState({ ...all, challengeFrame: false, status: 200 }).state, "login_wall");
	assert.equal(classifyPageState({ ...all, challengeFrame: false, status: 200, hasPassword: false }).state, "consent");
	assert.equal(classifyPageState({ ...all, challengeFrame: false, status: 200, hasPassword: false, consent: false }).state, "loading");
	assert.equal(classifyPageState({ readyState: "complete", textLength: 500, interactiveCount: 3 }).state, "ok");
});

test("classifyPageState: código de uso único é muro de login; página vazia ainda carrega; status desconhecido não é erro", () => {
	assert.equal(classifyPageState({ hasOtp: true, readyState: "complete", textLength: 99 }).state, "login_wall");
	assert.equal(classifyPageState({ readyState: "complete", textLength: 0, interactiveCount: 0 }).state, "loading");
	assert.equal(classifyPageState({ readyState: "complete", textLength: 0, interactiveCount: 2 }).state, "ok");
	assert.equal(classifyPageState({ status: undefined, readyState: "complete", textLength: 200, interactiveCount: 1 }).state, "ok");
	assert.equal(classifyPageState({ busy: true, readyState: "complete", textLength: 200, interactiveCount: 1 }).state, "loading");
	for (const state of PAGE_STATES) assert.equal(typeof state, "string");
});

const pages = {
	"/ok": "<title>ok</title><h1>Hello</h1><p>some real content in the page for the reader</p><a href='/x'>link</a>",
	"/login": "<title>login</title><form><input type='text' aria-label='User'><input type='password' aria-label='Senha'><button>Entrar</button></form>",
	"/hidden-password": "<title>x</title><p>some real content in the page for the reader</p><input type='password' style='display:none'><a href='/x'>l</a>",
	"/consent": "<title>c</title><p>some real content in the page for the reader</p><div id='cookie-banner' style='position:fixed;bottom:0;left:0;width:300px;height:60px;background:#eee'>We use cookies <button>Reject</button></div>",
	"/captcha": "<title>c</title><p>some real content in the page for the reader</p><iframe src='https://www.google.com/recaptcha/api2/anchor' style='width:300px;height:80px'></iframe>",
	"/busy": "<title>b</title><p>some real content in the page for the reader</p><div role='progressbar' style='width:50px;height:8px;background:#ccc'></div><a href='/x'>l</a>",
};
const fixture = await launchFixtureBrowser(pages);
after(async () => { await fixture?.close(); });

async function stateOf(path) {
	const page = await fixture.newPage();
	try {
		await page.goto(fixture.base + path, { waitUntil: "load" }).catch(() => undefined);
		return await readPageState(page);
	} finally {
		await page.close();
	}
}

test("readPageState (Chromium): ok, login, senha escondida, consentimento, captcha, ocupado", { skip: !fixture }, async () => {
	assert.equal((await stateOf("/ok"))?.state, "ok");
	assert.equal((await stateOf("/login"))?.state, "login_wall");
	assert.equal((await stateOf("/hidden-password"))?.state, "ok");
	assert.equal((await stateOf("/consent"))?.state, "consent");
	assert.equal((await stateOf("/busy"))?.state, "loading");
	// O fixture responde 200 a qualquer caminho; o captcha é pelo iframe (sem rede o frame fica em branco, mas o URL já basta).
	assert.equal((await stateOf("/captcha"))?.state, "challenge");
});

test("readPageState: página que falha ao avaliar devolve undefined (nunca lança)", async () => {
	const page = { evaluate: async () => { throw new Error("Execution context was destroyed"); }, frames: () => [], mainFrame: () => ({}) };
	assert.equal(await readPageState(page), undefined);
});
