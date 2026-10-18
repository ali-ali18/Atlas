import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createBrowserActions } from "./browser-actions.mjs";
import { createRefActions } from "./browser-refs.mjs";
import { createPageReader, parseReadArgs } from "./reader.mjs";
import { launchFixtureBrowser } from "./test-browser.mjs";

test("parseReadArgs: view, expand all/refs e validação dos refs", () => {
	assert.deepEqual(parseReadArgs({}), { view: "outline", expand: undefined, offset: undefined, limit: undefined });
	assert.equal(parseReadArgs({ view: "text", expand: "all" }).expand, "all");
	assert.deepEqual(parseReadArgs({ expand: ["e1", "f2e3"] }).expand, ["e1", "f2e3"]);
	assert.equal(parseReadArgs({ expand: [] }).expand, undefined);
	assert.throws(() => parseReadArgs({ expand: ["div"] }), /ref inválido/);
});

// 9 semanas, acordeão EXCLUSIVO e preguiçoso (o painel nasce vazio e é preenchido
// 120 ms depois). Todas as semanas têm a mesma linha "Mark as done": um diff de
// texto perderia essa linha a partir da segunda semana.
const lms = `<body style="margin:16px"><h1>Course</h1><p>Syllabus intro</p>
<nav><button aria-expanded="false" aria-haspopup="menu" onclick="window.__bad=(window.__bad||0)+1">Account</button></nav>
<a href="/elsewhere" aria-expanded="false" onclick="window.__bad=(window.__bad||0)+1">Catalog</a>
<button id="sub" aria-expanded="false" onclick="window.__bad=(window.__bad||0)+1">Submit assignment</button>
<div id="acc"></div>
<script>
const acc = document.getElementById('acc');
for (let i = 1; i <= 9; i++) acc.insertAdjacentHTML('beforeend', '<h3><button id="b'+i+'" aria-expanded="false" aria-controls="p'+i+'">Week '+i+'</button></h3><div id="p'+i+'" style="display:none"></div>');
acc.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const n = b.id.slice(1); const wasOpen = b.getAttribute('aria-expanded') === 'true';
  acc.querySelectorAll('button').forEach((x) => { x.setAttribute('aria-expanded', 'false'); const p = document.getElementById('p'+x.id.slice(1)); p.style.display = 'none'; p.innerHTML = ''; });
  if (wasOpen) return;
  b.setAttribute('aria-expanded', 'true');
  setTimeout(() => { const p = document.getElementById('p'+n); p.style.display = 'block'; p.innerHTML = '<p>Intro of week '+n+'</p><ul><li><a href="/u'+n+'">Unit '+n+' Intro</a></li><li>Activity guide '+n+'</li></ul><p>Mark as done</p>'; }, 120);
});
</script></body>`;

const host = `<body style="margin:10px"><h1>Course</h1><p>Main text</p>
<iframe id="same" src="/inner" width="400" height="120"></iframe>
<script>document.body.insertAdjacentHTML('beforeend','<iframe id="cross" src="http://localhost:'+location.port+'/inner2" width="400" height="120"></iframe>')</script>
<div id="host"></div>
<script>const r=document.getElementById('host').attachShadow({mode:'open'});r.innerHTML='<h2>Shadow title</h2><p>Shadow paragraph text</p><button>Shadow action</button>'</script>
<details><summary>More details</summary><p>Hidden detail text</p></details></body>`;
const inner = (word) => `<body style="margin:4px"><p>${word} text</p><button>${word} action</button></body>`;

const long = `<body>${Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i} ${"lorem ".repeat(40)}</p>`).join("")}</body>`;
const huge = `<body>${Array.from({ length: 1200 }, (_, i) => `<p>Row ${i} ${"data ".repeat(50)}</p>`).join("")}</body>`;

// "Next" é um <button> sem type dentro de um form POST (envia) com aria-expanded; o filtro GET abre de verdade.
const wform = `<body><h1>Order</h1>
<form action="/save" method="post"><button id="n" aria-expanded="false" onclick="window.__bad=(window.__bad||0)+1;return false">Next</button></form>
<form><button type="button" id="f" aria-expanded="false" aria-controls="fh">Filters</button><div id="fh" hidden>Filter help text</div></form>
<script>document.getElementById('f').onclick=(e)=>{e.preventDefault();e.target.setAttribute('aria-expanded','true');document.getElementById('fh').hidden=false}</script></body>`;

const fixtures = await launchFixtureBrowser({ "/wform": wform, "/lms": lms, "/host": host, "/inner": inner("Inner"), "/inner2": inner("Cross"), "/long": long, "/huge": huge });
after(() => fixtures?.close());
const skip = fixtures ? false : "Chromium/playwright-core indisponível";

async function open(path) {
	const page = await fixtures.newPage();
	await page.goto(`${fixtures.base}${path}`);
	await page.waitForLoadState("load");
	if (path === "/host") {
		await page.waitForFunction(() => document.querySelectorAll("iframe").length === 2);
		for (const frame of page.frames()) await frame.waitForLoadState("domcontentloaded").catch(() => {});
	}
	const actions = createBrowserActions({ getPage: async () => page });
	const refs = createRefActions({ withPageRetry: actions.withPageRetry, clickElement: actions.clickElement });
	actions.setObserver(refs.observeAction);
	const reader = createPageReader({
		withPageRetry: actions.withPageRetry,
		registry: refs.registry,
		collect: refs.collect,
		locateRef: refs.locateRef,
		observeAction: refs.observeAction,
		clickElement: actions.clickElement,
	});
	return { page, refs, reader };
}

test("real: read com iframe, outra origem e shadow DOM traz o texto em ordem, com refs", { skip }, async () => {
	const { reader } = await open("/host");
	const res = await reader.readPage({});
	const at = (needle) => {
		const i = res.text.indexOf(needle);
		assert.ok(i >= 0, `"${needle}" em:\n${res.text}`);
		return i;
	};
	assert.ok(at("Main text") < at("Inner text") && at("Inner text") < at("Cross text") && at("Cross text") < at("Shadow title"));
	assert.match(res.text, /\[frame f\d+ "same"\]/);
	assert.match(res.text, /\[frame f\d+ "\/inner2" other-origin localhost:\d+, untrusted\]/);
	assert.match(res.text, /# Course/);
	assert.match(res.text, /## Shadow title/);
	assert.match(res.text, /\[(f\d+e\d+)\] button "Inner action"/);
	assert.match(res.text, /\[(f\d+e\d+)\] button "Cross action"/);
	assert.match(res.text, /\[e\d+\] button "Shadow action"/);
	assert.equal(res.frames, 3);
	assert.ok(!res.text.includes("Hidden detail text"), "<details> fechado não entra");
	assert.match(res.text, /\[e\d+\] button "More details" collapsed/);
});

test("real: ler não renumera refs já dados e o ref de iframe vindo do read age no frame certo", { skip }, async () => {
	const { reader, refs } = await open("/host");
	const snap = await refs.browserSnapshot({});
	const before = snap.lines.find((l) => l.includes('"Inner action"'));
	const res = await reader.readPage({});
	const refBefore = /\[(f\d+e\d+)\]/.exec(before)[1];
	assert.ok(res.text.includes(`[${refBefore}] button "Inner action"`), "mesmo ref no snapshot e no read");
	const act = await refs.browserAct({ ref: refBefore, action: "hover" });
	assert.equal(act.ok, true);
});

test("real: read sem expand marca as seções fechadas e sugere a coleção", { skip }, async () => {
	const { reader } = await open("/lms");
	const res = await reader.readPage({});
	assert.equal(res.collapsed >= 9, true);
	assert.equal(res.similar.count, 9);
	assert.match(res.text, /### \[e\d+\] Week 1 \(collapsed\)/);
	assert.ok(!res.text.includes("Intro of week"));
	assert.equal(res.expanded, undefined);
});

test("real: expand all em acordeão exclusivo preguiçoso de 9 semanas devolve as 9 seções rotuladas, numa chamada", { skip }, async () => {
	const { reader, page } = await open("/lms");
	const res = await reader.readPage({ expand: "all", limit: 20000 });
	assert.equal(res.expanded.opened, 9, JSON.stringify(res.expanded));
	assert.equal(res.expanded.failed, 0);
	for (let n = 1; n <= 9; n += 1) {
		const section = new RegExp(`### Week ${n} \\[e\\d+\\]\\n- ?Intro of week ${n}|### Week ${n} \\[e\\d+\\]\\nIntro of week ${n}`);
		assert.match(res.text, section, `semana ${n}:\n${res.text}`);
		assert.match(res.text, new RegExp(`\\[e\\d+\\] link "Unit ${n} Intro" → /u${n}`));
		assert.match(res.text, new RegExp(`Activity guide ${n}`));
	}
	// A linha repetida existe em todas as semanas (um diff de texto a perderia).
	assert.equal(res.text.split("Mark as done").length - 1, 9);
	// Nunca clicou em menu, link de navegação nem envio.
	assert.equal(await page.evaluate(() => window.__bad), undefined);
	assert.equal(res.expanded.stoppedBy, undefined);
});

test("real: expand all não aperta botão de form que escreve, mesmo com nome neutro", { skip }, async () => {
	const { reader, page } = await open("/wform");
	const res = await reader.readPage({ expand: "all", limit: 20000 });
	assert.equal(await page.evaluate(() => window.__bad), undefined, "nenhum botão de envio foi clicado");
	assert.equal(res.expanded?.opened, 1, JSON.stringify(res.expanded));
	assert.match(res.text, /Filter help text/);
});

test("real: expand por refs abre só as seções pedidas", { skip }, async () => {
	const { reader } = await open("/lms");
	const first = await reader.readPage({});
	const week2 = /\[(e\d+)\] Week 2 \(collapsed\)/.exec(first.text)[1];
	const res = await reader.readPage({ expand: [week2] });
	assert.equal(res.expanded.opened, 1);
	assert.match(res.text, /### Week 2 \[e\d+\]/);
	assert.match(res.text, /Intro of week 2/);
	assert.ok(!res.text.includes("Intro of week 3"));
});

test("real: expand all abre <details> e lê o conteúdo", { skip }, async () => {
	const { reader } = await open("/host");
	const res = await reader.readPage({ expand: "all" });
	assert.equal(res.expanded.opened, 1);
	assert.match(res.text, /### More details[\s\S]*Hidden detail text/);
});

test("real: find acha texto dentro de iframe de outra origem, com ref vizinho e frame", { skip }, async () => {
	const { reader } = await open("/host");
	const res = await reader.findText({ query: "cross text" });
	assert.equal(res.total, 1);
	const [hit] = res.matches;
	assert.match(hit.crossOrigin, /^localhost:\d+$/);
	assert.match(hit.frame, /^f\d+$/);
	assert.match(hit.near, /^f\d+e\d+$/);
	assert.equal(res.frames, 3);
});

test("real: find 'Week 5' devolve o ref do botão da semana, sem ler a página inteira", { skip }, async () => {
	const { reader } = await open("/lms");
	const res = await reader.findText({ query: "Week 5" });
	assert.equal(res.total, 1);
	assert.equal(res.matches[0].role, undefined, "título com ref: o ref vem no próprio resultado");
	assert.match(res.matches[0].ref, /^e\d+$/);
	assert.equal(res.collapsed >= 9, true);
	await assert.rejects(() => reader.findText({ query: "  " }), /vazia/);
});

test("real: paginação por linha cobre o texto, continua do cache e informa total", { skip }, async () => {
	const { reader } = await open("/long");
	const first = await reader.readPage({ view: "text", limit: 3000 });
	assert.ok(first.text.length <= 3000);
	assert.equal(first.offset, 0);
	assert.ok(first.truncated && first.nextOffset > 0 && first.totalLength > 10_000);
	let text = first.text;
	let next = first.nextOffset;
	let guard = 0;
	while (next !== null && guard++ < 40) {
		const page = await reader.readPage({ view: "text", limit: 3000, offset: next });
		assert.equal(page.cached, true, "a continuação não relê a página");
		assert.equal(page.offset, next);
		text += page.text;
		next = page.nextOffset;
	}
	assert.equal(text.length, first.totalLength);
	assert.equal(text.split("Paragraph ").length - 1, 60);
});

test("real: limite máximo de 20000 e teto de páginas gigantes (nunca despeja megabytes)", { skip }, async () => {
	const { reader } = await open("/huge");
	const res = await reader.readPage({ view: "text", limit: 999_999 });
	assert.ok(res.text.length <= 20_000, `${res.text.length}`);
	assert.equal(res.capped, true);
	assert.ok(res.totalLength <= 400_000);
	assert.ok(res.nextOffset > 0);
});
