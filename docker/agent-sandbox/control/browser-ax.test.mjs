import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createBrowserActions } from "./browser-actions.mjs";
import { createRefActions } from "./browser-refs.mjs";
import { launchFixtureBrowser } from "./test-browser.mjs";
import { OOPIF_PAGE, fixtureA, fixtureYoutube, startSecondServer } from "./ax-fixtures.mjs";

const second = await startSecondServer({ "/pay": OOPIF_PAGE });
// A página A conhece o endereço do segundo servidor antes de subir.
const fixtures = await launchFixtureBrowser({
	"/a": fixtureA({ oopifBase: second.base, comments: 650 }),
	"/yt": fixtureYoutube({ comments: 1900 }),
});
after(async () => {
	await fixtures?.close();
	await second.close();
});
const skip = fixtures ? false : "Chromium/playwright-core indisponível";

async function open(path, options = {}) {
	const page = await fixtures.newPage();
	await page.goto(`${fixtures.base}${path}`);
	await page.waitForLoadState("load");
	for (const frame of page.frames()) await frame.waitForLoadState("domcontentloaded").catch(() => {});
	const actions = createBrowserActions({ getPage: async () => page });
	const refs = createRefActions({ withPageRetry: actions.withPageRetry, clickElement: actions.clickElement, ...options });
	actions.setObserver(refs.observeAction);
	return { page, refs };
}
const refIn = (tree, pattern) => {
	const line = tree.split("\n").find((l) => pattern.test(l));
	assert.ok(line, `${pattern} não está em:\n${tree}`);
	return /\[((?:f\d+)?e\d+)\]/.exec(line)[1];
};

test("fixture A: o chunk 1 traz aside e OOPIF em menos de 2.000 caracteres, sem ocultos e sem senha", { skip }, async () => {
	const { page, refs } = await open("/a");
	const started = Date.now();
	const snap = await refs.browserSnapshot({});
	const took = Date.now() - started;
	console.log(`[medida] fixture A (~${await page.evaluate(() => document.getElementsByTagName("*").length)} elementos): chunk 1 = ${snap.tree.length} chars, ${took} ms, treeLength=${snap.treeLength}`);
	assert.equal(snap.engine, "ax");
	assert.ok(snap.tree.length < 2000, `${snap.tree.length} chars:\n${snap.tree}`);
	assert.match(snap.tree, /complementary "Chat"/);
	assert.match(snap.tree, /button "Enviar" \[e\d+\]/);
	assert.match(snap.tree, /button "Pagar no iframe" \[f\d+e\d+\]/, "o iframe de outro site entra com a ref do frame");
	assert.match(snap.tree, /button "Dentro do shadow"/);
	assert.match(snap.tree, /button \[e\d+\] \[aria-hidden\]\n\s+Decorativo/);
	assert.doesNotMatch(snap.tree, /Interno do acordeão|texto escondido|link fora da tela/, "acordeão fechado e fora da tela não aparecem");
	assert.ok(snap.hidden >= 2);
	assert.match(snap.tree, /textbox "Nome" \[e\d+\]: "ana"/);
	assert.match(snap.tree, /textbox "Senha" \[e\d+\] \(campo de senha: nunca preencha\)/);
	assert.ok(snap.lines.some((l) => l.includes("(campo de senha")), "lines[] segue alimentando o muro de login");
	assert.equal(JSON.stringify(snap).includes("s3gredo-zzz"), false, "o valor da senha nunca aparece");
	assert.match(snap.tree, /fora da janela/);
	await page.close();
});

test("fixture A: a ref do aside clica; o diff fica abaixo de 25 linhas e sem senha", { skip }, async () => {
	const { page, refs } = await open("/a");
	const snap = await refs.browserSnapshot({});
	const result = await refs.browserAct({ ref: refIn(snap.tree, /button "Enviar"/), action: "click" });
	assert.equal(result.ok, true);
	assert.equal(await page.locator("#log p").count(), 1);
	const tree = result.changes?.tree ?? [];
	assert.ok(tree.length > 0 && tree.length < 25, JSON.stringify(result.changes));
	assert.ok(tree.some((l) => /mensagem enviada/.test(l)));
	assert.equal(JSON.stringify(result).includes("s3gredo-zzz"), false);
	await page.close();
});

test("fixture A: ref vencida (aside recriado) é re-resolvida e avisa", { skip }, async () => {
	const { page, refs } = await open("/a");
	const snap = await refs.browserSnapshot({});
	const ref = refIn(snap.tree, /button "Enviar"/);
	await page.evaluate(() => {
		const aside = document.querySelector("aside");
		aside.innerHTML = aside.innerHTML;
	});
	const started = Date.now();
	const result = await refs.browserAct({ ref, action: "click" });
	assert.match(result.note, /tinha vencido/);
	assert.equal(await page.locator("#log p").count(), 1);
	assert.ok(Date.now() - started < 4000);
	await page.close();
});

test("fixture A: a ref dentro do OOPIF clica", { skip }, async () => {
	const { page, refs } = await open("/a");
	const snap = await refs.browserSnapshot({});
	await refs.browserAct({ ref: refIn(snap.tree, /Pagar no iframe/), action: "click" });
	const frame = page.frames().find((f) => f.url().includes("/pay"));
	assert.equal(await frame.title(), "pago");
	await page.close();
});

test("fixture A: abrir o acordeão faz o conteúdo aparecer no snapshot seguinte", { skip }, async () => {
	const { page, refs } = await open("/a");
	const snap = await refs.browserSnapshot({});
	await refs.browserAct({ ref: refIn(snap.tree, /button "Abrir seção"/), action: "click" });
	const after = await refs.browserSnapshot({});
	assert.match(after.tree, /button "Interno do acordeão"/);
	await page.close();
});

test("fixture A: area=page pagina por caracteres; ref= abre os filhos do bloco colapsado", { skip }, async () => {
	const { page, refs } = await open("/a");
	const full = await refs.browserSnapshot({ area: "page", limit: 3000 });
	assert.match(full.tree, /similares \(e\d+\.\.e\d+\) — browser_snapshot ref=e\d+/);
	assert.ok(full.treeLength > 0);
	if (full.nextOffset !== null) {
		const next = await refs.browserSnapshot({ area: "page", offset: full.nextOffset, limit: 3000 });
		assert.equal(next.cached, true);
		assert.notEqual(next.tree, full.tree);
	}
	const container = /similares \([^)]*\) — browser_snapshot ref=(e\d+)/.exec(full.tree)[1];
	const opened = await refs.browserSnapshot({ ref: container, limit: 4000 });
	assert.equal(opened.area, "ref");
	assert.ok((opened.tree.match(/^ *article/gm) ?? []).length >= 3, opened.tree.slice(0, 300));
	assert.doesNotMatch(opened.tree.split("\n").slice(0, 12).join("\n"), /similares/, "o primeiro nível vem inteiro");
	await page.close();
});

test("com a flag desligada o v1 continua igual (lista de elementos, sem árvore)", { skip }, async () => {
	const { page, refs } = await open("/a", { axOn: () => false });
	const snap = await refs.browserSnapshot({});
	assert.equal(snap.engine, "dom");
	assert.equal(snap.tree, undefined);
	assert.ok(snap.lines.length > 0 && snap.lines.some((l) => /Enviar/.test(l)));
	assert.equal(snap.note, undefined);
	const ref = /\[(e\d+)\]/.exec(snap.lines.find((l) => /Enviar/.test(l)))[1];
	await refs.browserAct({ ref, action: "click" });
	assert.equal(await page.locator("#log p").count(), 1);
	await page.close();
});

test("engine=dom por pedido e scope também usam o v1", { skip }, async () => {
	const { page, refs } = await open("/a");
	assert.equal((await refs.browserSnapshot({ engine: "dom" })).engine, "dom");
	assert.equal((await refs.browserSnapshot({ scope: "aside" })).engine, "dom");
	await page.close();
});

test("fixture YouTube-like: o chunk 1 traz a resposta do aside em menos de 2.000 caracteres; a ref clica", { skip }, async () => {
	const { page, refs } = await open("/yt");
	const nodes = await page.evaluate(() => document.getElementsByTagName("*").length);
	const started = Date.now();
	const snap = await refs.browserSnapshot({});
	const took = Date.now() - started;
	console.log(`[medida] fixture YouTube-like (~${nodes} elementos): chunk 1 = ${snap.tree.length} chars, ${took} ms, treeLength=${snap.treeLength}`);
	assert.equal(snap.engine, "ax");
	assert.ok(snap.tree.length < 2000, `${snap.tree.length}:\n${snap.tree}`);
	assert.match(snap.tree, /Resposta pronta: a árvore de acessibilidade resolve isso/);
	const result = await refs.browserAct({ ref: refIn(snap.tree, /button "Copiar resposta"/), action: "click" });
	assert.equal(await page.title(), "copiado");
	assert.ok(result.changes?.tree?.length < 25);
	await page.close();
});

test("árvore lenta (timeout curto) cai no v1 com uma nota, sem falhar", { skip }, async () => {
	const { page, refs } = await open("/yt", { axTimeoutMs: 20 });
	const snap = await refs.browserSnapshot({});
	assert.equal(snap.engine, "dom");
	assert.match(snap.note, /Árvore de acessibilidade indisponível \(demorou mais de 4 s\)/);
	assert.ok(snap.lines.length > 0);
	await page.close();
});
