import test, { after } from "node:test";
import assert from "node:assert/strict";
import { parseAxYaml } from "./ax-prune.mjs";
import { createAxStore, buildRefTable, resolveAxRef, StaleRefError } from "./ax-refs.mjs";
import { takeAxSnapshot } from "./ax-snapshot.mjs";
import { launchFixtureBrowser } from "./test-browser.mjs";

const YAML = `- main [ref=e1]:
  - complementary "Chat" [ref=e2]:
    - button "Responder" [ref=e3]
    - button "Responder" [ref=e4]
  - iframe [ref=e5]:
    - button "Dentro" [ref=f1e2]
  - generic [ref=e6]`;

test("tabela: papel, nome, ordinal entre iguais, total e âncora; generic sem nome fica de fora", () => {
	const table = buildRefTable(parseAxYaml(YAML).byRef);
	assert.deepEqual(
		[table.get("a3").nth, table.get("a3").of, table.get("a4").nth, table.get("a3").anchor],
		[0, 2, 1, 'complementary "Chat"'],
	);
	assert.equal(table.get("f1a2").frame, "f1");
	assert.equal(table.has("a6"), false);
	assert.equal(table.has("a1"), false);
});

test("store: snapshot do dom troca o motor; novo ax mescla a tabela antiga", () => {
	const store = createAxStore();
	const page = {};
	store.setAx(page, { table: new Map([["a1", { role: "button" }]]), flat: new Map() });
	store.setAx(page, { table: new Map([["a2", { role: "link" }]]), flat: new Map() });
	assert.deepEqual([...store.get(page).table.keys()], ["a1", "a2"]);
	store.setDom(page);
	assert.equal(store.engineOf(page), "dom");
});

test("store: navegar zera a tabela (ref velha não casa por papel+nome na página nova); DOM guarda a tabela só na mesma URL", () => {
	const store = createAxStore();
	let href = "http://x/a";
	const page = { url: () => href };
	store.setAx(page, { table: new Map([["a1", { role: "button" }]]), flat: new Map(), url: href });
	href = "http://x/b";
	store.setAx(page, { table: new Map([["a2", { role: "link" }]]), flat: new Map(), url: href });
	assert.deepEqual([...store.get(page).table.keys()], ["a2"]);
	store.setDom(page);
	assert.deepEqual([...store.tableFor(page).keys()], ["a2"]);
	href = "http://x/c";
	assert.equal(store.tableFor(page), undefined);
});

test("store: clearRendered descarta o texto em cache da paginação", () => {
	const store = createAxStore();
	const page = { url: () => "u" };
	store.setAx(page, { table: new Map(), flat: new Map(), url: "u" });
	store.setRendered(page, { key: "k", url: "u", lines: [], meta: {} });
	store.clearRendered(page);
	assert.equal(store.get(page).rendered, null);
});

const fixture = await launchFixtureBrowser({
	"/": `<title>t</title><div id=box><button id=a>Curtir</button></div><ul id=lista><li><button>Responder</button> um</li><li><button>Responder</button> dois</li></ul>`,
});
after(async () => fixture?.close());

async function snap(page) {
	const { yaml } = await takeAxSnapshot(page);
	return buildRefTable(parseAxYaml(yaml).byRef);
}
const refOf = (table, role, name, nth = 0) => [...table].filter(([, e]) => e.role === role && e.name === name)[nth][0];

test("Chromium real: ref viva age direto, sem aviso", { skip: !fixture }, async () => {
	const page = await fixture.newPage();
	await page.goto(`${fixture.base}/`);
	const table = await snap(page);
	const { locator, resolved } = await resolveAxRef(page, table, refOf(table, "button", "Curtir"));
	assert.equal(resolved, undefined);
	assert.equal(await locator.textContent(), "Curtir");
	await page.close();
});

test("Chromium real: ref vencida com um só candidato é re-resolvida e avisa", { skip: !fixture }, async () => {
	const page = await fixture.newPage();
	await page.goto(`${fixture.base}/`);
	const table = await snap(page);
	const ref = refOf(table, "button", "Curtir");
	await page.evaluate(() => { const box = document.getElementById("box"); box.innerHTML = box.innerHTML; });
	const started = Date.now();
	const { locator, resolved } = await resolveAxRef(page, table, ref);
	assert.match(resolved, /tinha vencido/);
	assert.equal(await locator.textContent(), "Curtir");
	assert.ok(Date.now() - started < 1500, "não espera timeout");
	await page.close();
});

test("Chromium real: ref vencida com vários iguais falha rápido listando candidatas", { skip: !fixture }, async () => {
	const page = await fixture.newPage();
	await page.goto(`${fixture.base}/`);
	const table = await snap(page);
	const ref = refOf(table, "button", "Responder", 1);
	await page.evaluate(() => { const ul = document.getElementById("lista"); ul.innerHTML = ul.innerHTML; });
	const started = Date.now();
	await assert.rejects(resolveAxRef(page, table, ref), (error) => {
		assert.ok(error instanceof StaleRefError);
		assert.match(error.message, /há 2 button "Responder"/);
		assert.match(error.message, /era a 2ª de 2/);
		assert.match(error.message, /perto de "Responder um"/);
		return true;
	});
	assert.ok(Date.now() - started < 1500);
	await page.close();
});

test("Chromium real: ref vencida cujo elemento sumiu pede novo snapshot", { skip: !fixture }, async () => {
	const page = await fixture.newPage();
	await page.goto(`${fixture.base}/`);
	const table = await snap(page);
	const ref = refOf(table, "button", "Curtir");
	await page.evaluate(() => document.getElementById("box").remove());
	await assert.rejects(resolveAxRef(page, table, ref), /não está mais na página/);
	await assert.rejects(resolveAxRef(page, table, "a999"), /venceu/);
	await page.close();
});
