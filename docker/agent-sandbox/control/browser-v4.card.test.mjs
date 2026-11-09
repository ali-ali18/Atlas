// F8 auditoria #1: depois do `card_fill` o número, o CVV e o titular não podem sair por nenhuma leitura da página
// (mapa, partes, busca, ação, árvore, screenshot). Chromium real; sem ele os testes se pulam.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserActions } from "./browser-actions.mjs";
import { createRefActions } from "./browser-refs.mjs";
import { createBrowserV4 } from "./browser-v4.mjs";
import { createPlaywrightDriver } from "./card-fill-driver.mjs";
import { launchFixtureBrowser } from "./test-browser.mjs";

const CARD = { number: "4111111111111111", holder: "MARIA LIMA", expMonth: 9, expYear: 2031, cvv: "737" };
const CHECKOUT = `<!doctype html><html><head><title>Checkout</title></head><body><main><h1>Pagamento</h1>
<form action="/pay" method="post">
<div class="a"><label>Número do cartão <input name="cardnumber" autocomplete="cc-number" type="text"></label></div>
<p class="b"><label>Validade <input autocomplete="cc-exp" placeholder="MM / YY" type="text"></label></p>
<section class="c"><label>Código <input autocomplete="cc-csc" type="text"></label></section>
<fieldset class="d"><label>Nome no cartão <input autocomplete="cc-name" type="text"></label></fieldset>
<span class="e"><label>Cupom <input name="coupon" type="text" value="DESCONTO10"></label></span>
<button type="submit">Pagar</button></form></main></body></html>`;

const SPA = `<!doctype html><html><body><div><input autocomplete="cc-number" type="text"><button onclick="document.title='clicked'">Pagar</button></div></body></html>`;
const SPA_FORM = `<!doctype html><html><head><title>Spa</title></head><body><main><h1>Newsletter</h1>
<form id="f"><label>Email <input name="email" type="text"></label><button id="go">Enviar</button><button type="button" id="plain" onclick="document.title='plain'">Cancelar</button></form>
<div role="button" tabindex="0" id="div" onclick="document.title='div'">Salvar</div>
</main><script>document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); document.title = "sent"; });</script></body></html>`;
const MORE_FORM = `<!doctype html><html><body><main><h1>Lista</h1>
<ul id="l">${Array.from({ length: 6 }, (_, i) => `<li class="c"><span>Item numero ${i + 1} com texto suficiente para contar</span></li>`).join("")}</ul>
<form action="/post" method="post"><button type="submit" id="m" onclick="document.title='enviado'">Show more comments</button></form></main></body></html>`;
const fixtures = await launchFixtureBrowser({ "/checkout": CHECKOUT, "/spa": SPA, "/spaform": SPA_FORM, "/moreform": MORE_FORM });
after(async () => {
	await fixtures?.close();
});
const skip = fixtures ? false : "Chromium/playwright-core indisponível";
const SECRETS = [CARD.number, CARD.number.slice(0, 8), CARD.cvv, CARD.holder, "MARIA", "09/31"];

async function setup() {
	const page = await fixtures.newPage();
	await page.goto(`${fixtures.base}/checkout`);
	await page.waitForLoadState("load");
	const actions = createBrowserActions({ getPage: async () => page });
	const refs = createRefActions({ withPageRetry: actions.withPageRetry, clickElement: actions.clickElement });
	actions.setObserver(refs.observeAction);
	const handle = createBrowserV4({
		withPageRetry: actions.withPageRetry,
		collect: refs.collect,
		noteDomRefs: () => refs.axStore.setDom(page),
		browserAct: refs.browserAct,
		browserWait: refs.browserWait,
		navigate: actions.navigate,
		listTabs: async () => [{ index: 1, url: page.url(), title: await page.title(), active: true }],
		switchTab: async () => {},
		closeTab: async () => {},
		clickElement: actions.clickElement,
		locateRef: refs.locateRef,
		workspaceDir: await mkdtemp(join(tmpdir(), "atlas-v4-card-")),
		fs: fsp,
	});
	return { page, handle, refs };
}
const leaks = (value) => SECRETS.filter((secret) => JSON.stringify(value).includes(secret));

test("depois do card_fill, mapa, partes e busca não mostram número, CVV, validade nem titular", { skip }, async () => {
	const { page, handle } = await setup();
	const filled = await createPlaywrightDriver(page).fillCard(CARD);
	assert.deepEqual(filled, { number: true, exp: true, cvv: true });
	const seen = [];
	const map = await handle("browser.map", {});
	assert.equal(map.ok, true, map.error);
	seen.push(map.data);
	for (const section of map.data.sections) {
		const read = await handle("browser.read", { section: section.id, from: 1, count: 50 });
		if (read.ok) seen.push(read.data);
		const found = await handle("browser.find", { query: "4111", section: section.id });
		if (found.ok) seen.push(found.data);
	}
	seen.push(await handle("browser.find", { query: "MARIA" }), await handle("browser.find", { query: "737" }));
	assert.deepEqual(leaks(seen), []);
	assert.match(JSON.stringify(seen), /DESCONTO10/, "campo comum continua legível");
});

test("depois do card_fill, a árvore e a ação não devolvem os valores do cartão", { skip }, async () => {
	const { page, handle, refs } = await setup();
	await createPlaywrightDriver(page).fillCard(CARD);
	const snap = await refs.browserSnapshot({ mode: "full" });
	if (leaks(snap).length) console.log("SNAP", JSON.stringify(snap).slice(0, 2500));
	assert.deepEqual(leaks(snap), []);
	const read = await handle("browser.read", { section: "s2", from: 1, count: 50 });
	const ref = JSON.stringify(read).match(/"ref":"([ae]\d+)"/)?.[1];
	if (ref) {
		const typed = await handle("browser.act", { ref, action: "type", text: "x" });
		assert.deepEqual(leaks(typed), []);
	}
});

test("screenshot é recusado enquanto houver campo de cartão preenchido, e liberado depois de limpar", { skip }, async () => {
	const { page, handle } = await setup();
	const driver = createPlaywrightDriver(page);
	await driver.goto(`${fixtures.base}/checkout`);
	await driver.fillCard(CARD);
	const refused = await handle("browser.screenshot", {});
	assert.equal(refused.ok, false);
	assert.equal(refused.code, "card_on_page");
	assert.deepEqual(leaks(refused), []);
	await driver.clearCard();
	const shot = await handle("browser.screenshot", {});
	assert.equal(shot.ok, true, shot.error);
});

test("tentar digitar num campo de cartão pela ação devolve needsOwner card", { skip }, async () => {
	const { page, handle } = await setup();
	const map = await handle("browser.map", {});
	const form = map.data.sections.find((s) => s.kind === "form");
	assert.ok(form, "o formulário vira seção");
	const read = await handle("browser.read", { section: form.id, from: 1, count: 20 });
	const items = read.data.items;
	const numberItem = items.find((i) => /card field/.test(i.text) && /mero/.test(i.text));
	assert.ok(numberItem, JSON.stringify(items));
	const out = await handle("browser.act", { ref: numberItem.refs[0].ref, action: "type", text: "4111" });
	assert.equal(out.ok, true);
	assert.equal(out.data.needsOwner, "card");
});

test("botão de pagar real: o envio do formulário do cartão; página sem formulário não tem envio estrutural", { skip }, async () => {
	const page = await fixtures.newPage();
	await page.goto(`${fixtures.base}/checkout`);
	const driver = createPlaywrightDriver(page);
	await driver.goto(`${fixtures.base}/checkout`);
	assert.deepEqual(await driver.findPayControl(), { label: "Pagar" });
	const spa = await fixtures.newPage();
	const spaDriver = createPlaywrightDriver(spa);
	await spaDriver.goto(`${fixtures.base}/spa`);
	assert.equal(await spaDriver.findPayControl(), null);
	assert.equal(await spaDriver.clickPay(), false);
	assert.notEqual(await spa.title(), "clicked");
});

test("form de SPA sem action: clique no envio e Enter no campo exigem intent submit; botão type=button e div seguem pelo intent", { skip }, async () => {
	const page = await fixtures.newPage();
	await page.goto(`${fixtures.base}/spaform`);
	const actions = createBrowserActions({ getPage: async () => page });
	const refs = createRefActions({ withPageRetry: actions.withPageRetry, clickElement: actions.clickElement });
	actions.setObserver(refs.observeAction);
	const handle = createBrowserV4({ withPageRetry: actions.withPageRetry, collect: refs.collect, noteDomRefs: () => refs.axStore.setDom(page), browserAct: refs.browserAct, browserWait: refs.browserWait, navigate: actions.navigate, listTabs: async () => [], switchTab: async () => {}, closeTab: async () => {}, clickElement: actions.clickElement, locateRef: refs.locateRef, workspaceDir: await mkdtemp(join(tmpdir(), "atlas-v4-spa-")), fs: fsp });
	const map = await handle("browser.map", {});
	const refsByLabel = {};
	for (const section of map.data.sections) {
		const read = await handle("browser.read", { section: section.id, from: 1, count: 20 });
		for (const item of read.data?.items ?? []) for (const r of item.refs ?? []) refsByLabel[r.name] = r.ref;
	}
	const { Enviar, Email, Cancelar } = refsByLabel;
	assert.ok(Enviar && Email && Cancelar, JSON.stringify(refsByLabel));
	const click = await handle("browser.act", { ref: Enviar, action: "click", intent: "browse" });
	assert.equal(click.code, "SUBMIT_INTENT_REQUIRED");
	for (const key of ["Enter", "NumpadEnter", "Control+Enter"]) {
		const press = await handle("browser.act", { ref: Email, action: "press", text: key, intent: "browse" });
		assert.equal(press.code, "SUBMIT_INTENT_REQUIRED", key);
	}
	assert.equal(await page.title(), "Spa", "nada foi enviado");
	const plain = await handle("browser.act", { ref: Cancelar, action: "click", intent: "browse" });
	assert.equal(plain.ok, true, "type=button não é envio estrutural");
	const sent = await handle("browser.act", { ref: Enviar, action: "click", intent: "submit" });
	assert.equal(sent.ok, true);
});

test("carregar mais nunca clica num botão de formulário, mesmo com o texto de 'mostrar mais'", { skip }, async () => {
	const page = await fixtures.newPage();
	await page.goto(`${fixtures.base}/moreform`);
	const actions = createBrowserActions({ getPage: async () => page });
	const refs = createRefActions({ withPageRetry: actions.withPageRetry, clickElement: actions.clickElement });
	actions.setObserver(refs.observeAction);
	const handle = createBrowserV4({ withPageRetry: actions.withPageRetry, collect: refs.collect, noteDomRefs: () => refs.axStore.setDom(page), browserAct: refs.browserAct, browserWait: refs.browserWait, navigate: actions.navigate, listTabs: async () => [], switchTab: async () => {}, closeTab: async () => {}, clickElement: actions.clickElement, locateRef: refs.locateRef, workspaceDir: await mkdtemp(join(tmpdir(), "atlas-v4-more-")), fs: fsp });
	const map = await handle("browser.map", {});
	const list = map.data.sections.find((s) => s.kind === "list");
	assert.ok(list);
	assert.equal(list.canLoadMore, false, "o botão de formulário não vira 'carregar mais'");
	await handle("browser.load_more", { section: list.id, times: 1 });
	assert.equal(await page.title(), "", "o botão do formulário não foi clicado");
});
