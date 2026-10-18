import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ADDED_MAX_CHARS, diffPageDigest, summarizeChanges } from "./page-digest.mjs";
import { createBrowserActions } from "./browser-actions.mjs";
import { createRefActions } from "./browser-refs.mjs";
import { launchFixtureBrowser } from "./test-browser.mjs";

const digest = (over = {}) => ({
	doc: "d1",
	url: "https://x.test/a",
	title: "A",
	blocks: [],
	states: [],
	dialogs: [],
	refs: [],
	errors: [],
	...over,
});

// --- diffPageDigest / summarizeChanges (puros) ---

test("diff: texto novo, removido e título/URL", () => {
	const before = digest({ blocks: ["Week 1", "Week 2", "Footer"] });
	const after = digest({ blocks: ["Week 1", "Unit 01 Intro", "Activity guide", "Footer"], title: "B", url: "https://x.test/b" });
	const diff = diffPageDigest(before, after);
	assert.deepEqual(diff.added, ["Unit 01 Intro", "Activity guide"]);
	assert.equal(diff.removedBlocks, 1);
	assert.equal(diff.urlChanged, true);
	assert.equal(diff.titleChanged, true);
	assert.equal(diff.reloaded, false);
});

test("diff: nada novo -> tudo vazio; documento novo não compara texto", () => {
	const same = digest({ blocks: ["a", "b"] });
	const diff = diffPageDigest(same, digest({ blocks: ["a", "b"] }));
	assert.deepEqual(summarizeChanges(diff), {});
	const reloaded = diffPageDigest(same, digest({ doc: "d2", blocks: ["x"] }));
	assert.equal(reloaded.reloaded, true);
	assert.deepEqual(reloaded.added, []);
	assert.equal(diffPageDigest(null, same), null);
});

test("diff: estados aria trocados, diálogo aberto/fechado, refs que reapareceram", () => {
	const before = digest({
		states: [{ id: 1, ref: "e20", name: "Week 1", kind: "expanded", value: "false" }],
		dialogs: [{ id: 9, title: "Old" }],
		refs: ["e1", "e2"],
	});
	const after = digest({
		states: [{ id: 1, ref: "e20", name: "Week 1", kind: "expanded", value: "true" }],
		dialogs: [{ id: 10, title: "Confirm" }],
		refs: ["e1", "e2", "e21", "e22"],
	});
	const diff = diffPageDigest(before, after);
	assert.deepEqual(diff.states, ['e20 "Week 1" expanded false→true']);
	assert.deepEqual(diff.dialogsOpened, ["Confirm"]);
	assert.deepEqual(diff.dialogsClosed, ["Old"]);
	assert.deepEqual(diff.reappeared, ["e21", "e22"]);
});

test("diff: erro preexistente (banner) não conta; erro novo sim", () => {
	const banner = "Press Tab to navigate";
	const diff = diffPageDigest(digest({ errors: [banner] }), digest({ errors: [banner, "email: required"] }));
	assert.deepEqual(diff.errors, ["email: required"]);
	assert.deepEqual(diffPageDigest(digest({ errors: [banner] }), digest({ errors: [banner] })).errors, []);
});

test("summarize: texto novo com teto duro e total real quando passa do teto", () => {
	const blocks = Array.from({ length: 30 }, (_, i) => `Unit ${String(i).padStart(2, "0")} ${"x".repeat(60)}`);
	const changes = summarizeChanges(diffPageDigest(digest(), digest({ blocks })));
	assert.ok(changes.added.length <= ADDED_MAX_CHARS);
	assert.equal(changes.addedBlocks, 30);
	assert.ok(changes.addedTotalChars > ADDED_MAX_CHARS);
	assert.ok(changes.added.startsWith("Unit 00"));
});

// --- Chromium real ---

const accordion = `<body style="margin:20px"><div id="weeks"></div><script>
const weeks=document.getElementById('weeks');
for (let n=1;n<=3;n++){
  const b=document.createElement('button'); b.textContent='Week '+n; b.setAttribute('aria-expanded','false'); b.setAttribute('aria-controls','p'+n);
  const p=document.createElement('div'); p.id='p'+n; p.style.cssText='height:0;overflow:hidden';
  b.onclick=async()=>{
    const open=b.getAttribute('aria-expanded')!=='true';
    for (const o of weeks.querySelectorAll('button')) { o.setAttribute('aria-expanded','false'); document.getElementById(o.getAttribute('aria-controls')).style.height='0'; }
    if(!open) return;
    if(!p.dataset.loaded){ await fetch('/data/'+n).then(r=>r.text()); p.dataset.loaded='1';
      p.innerHTML='<ul><li><a href="/u/'+n+'a">Unit 0'+n+' Intro</a></li><li><a href="/u/'+n+'b">Activity guide '+n+'</a></li></ul>'; }
    b.setAttribute('aria-expanded','true'); p.style.height='auto';
  };
  weeks.append(b,p);
}
</script></body>`;

const modal = `<body style="margin:20px"><button id="open" onclick="document.getElementById('dlg').hidden=false">Open settings</button>
<div id="dlg" role="dialog" aria-label="Settings" hidden style="position:fixed;left:100px;top:100px;width:300px;height:200px;background:#eee"><p>Pick a theme</p><button id="close" onclick="document.getElementById('dlg').hidden=true">Done</button></div></body>`;

const noop = `<body style="margin:20px"><button onclick="void 0">Nothing</button><p>Static text here for the page</p></body>`;

const spa = `<body style="margin:20px"><a id="go" href="#" onclick="event.preventDefault();history.pushState({}, '', '/courses');setTimeout(()=>{document.title='Courses';document.getElementById('app').innerHTML='<h1>Courses</h1><p>'+'Lorem ipsum dolor sit amet. '.repeat(4)+'</p>'},120)">Go to courses</a><div id="app"><p>Home page content that is long enough to be ready</p></div></body>`;

const form = `<body style="margin:20px"><div role="alert">Site accessibility: press Tab to navigate</div>
<form id="f" onsubmit="event.preventDefault();document.getElementById('name').setAttribute('aria-invalid','true');document.getElementById('err').textContent='Name is required'">
<input id="name" aria-label="Name"><div id="err" role="alert"></div><button type="submit">Save</button></form>
<button onclick="document.body.insertAdjacentHTML('beforeend','<div role=alert>Cookie notice updated</div>')">Banner</button></body>`;

const fixtures = await launchFixtureBrowser({
	"/accordion": accordion,
	"/modal": modal,
	"/noop": noop,
	"/spa": spa,
	"/form": form,
});
after(() => fixtures?.close());
const skip = fixtures ? false : "Chromium/playwright-core indisponível";

async function open(path) {
	const page = await fixtures.newPage();
	await page.goto(`${fixtures.base}${path}`);
	const actions = createBrowserActions({ getPage: async () => page });
	const refs = createRefActions({ withPageRetry: actions.withPageRetry, clickElement: actions.clickElement });
	actions.setObserver(refs.observeAction);
	const snap = await refs.browserSnapshot({});
	const refOf = (label) => {
		const line = snap.lines.find((l) => l.includes(`"${label}"`));
		assert.ok(line, `ref de "${label}" no snapshot: ${snap.lines.join(" / ")}`);
		return /\[(e\d+)\]/.exec(line)[1];
	};
	return { page, actions, refs, refOf };
}

test("real: expandir uma semana devolve os títulos revelados, o estado e os refs novos", { skip }, async () => {
	const { refs, refOf } = await open("/accordion");
	const res = await refs.browserAct({ ref: refOf("Week 1"), action: "click" });
	assert.match(res.changes.added, /Unit 01 Intro/);
	assert.match(res.changes.added, /Activity guide 1/);
	assert.ok(res.changes.states.some((s) => /"Week 1" expanded false→true/.test(s)), JSON.stringify(res.changes));
	assert.ok(res.newElements.some((l) => /Unit 01 Intro/.test(l)), res.newElements.join("\n"));
	assert.equal(res.settled, true);
});

test("real: acordeão exclusivo: trocar de semana traz o conteúdo novo; reabrir devolve os refs já vistos", { skip }, async () => {
	const { refs, refOf } = await open("/accordion");
	const w1 = refOf("Week 1");
	const w2 = refOf("Week 2");
	await refs.browserAct({ ref: w1, action: "click" });
	const second = await refs.browserAct({ ref: w2, action: "click" });
	assert.match(second.changes.added, /Unit 02 Intro/);
	assert.ok(second.changes.states.some((s) => /"Week 1" expanded true→false/.test(s)));
	assert.ok(second.changes.removedBlocks >= 2, "o conteúdo da semana 1 sumiu");
	const reopened = await refs.browserAct({ ref: w1, action: "click" });
	assert.match(reopened.changes.added, /Unit 01 Intro/);
	// Os links já tinham ref: voltam como "novos" porque reapareceram.
	assert.ok(reopened.newElements.some((l) => /Unit 01 Intro/.test(l)), reopened.newElements.join("\n"));
});

test("real: lote de 3 cliques mantém o diff de cada ação (nenhum conteúdo se perde)", { skip }, async () => {
	const { refs, refOf } = await open("/accordion");
	const results = [];
	for (const week of ["Week 1", "Week 2", "Week 3"]) {
		results.push(await refs.browserAct({ ref: refOf(week), action: "click" }));
	}
	results.forEach((res, i) => assert.match(res.changes.added, new RegExp(`Unit 0${i + 1} Intro`)));
});

test("real: abrir um modal informa o diálogo e os refs novos; fechar informa que fechou", { skip }, async () => {
	const { refs, refOf } = await open("/modal");
	const opened = await refs.browserAct({ ref: refOf("Open settings"), action: "click" });
	assert.deepEqual(opened.changes.dialogsOpened, ["Settings"]);
	assert.ok(opened.newElements.some((l) => /"Done"/.test(l)));
	const doneRef = /\[(e\d+)\]/.exec(opened.newElements.find((l) => /"Done"/.test(l)))[1];
	const closed = await refs.browserAct({ ref: doneRef, action: "click" });
	assert.deepEqual(closed.changes.dialogsClosed, ["Settings"]);
});

test("real: clique sem efeito -> sem mudanças e espera curta (<= 450 ms)", { skip }, async () => {
	const { refs, refOf } = await open("/noop");
	const res = await refs.browserAct({ ref: refOf("Nothing"), action: "click" });
	assert.equal(res.changes, undefined);
	assert.equal(res.newTotal, 0);
	assert.equal(res.navigated, false);
	assert.ok(res.waitMs <= 450, `waitMs=${res.waitMs}`);
	console.log(`# espera de clique sem efeito: ${res.waitMs} ms`);
});

test("real: rota de SPA muda a URL, entrega o conteúdo novo e fica pronta", { skip }, async () => {
	const { refs, refOf } = await open("/spa");
	const res = await refs.browserAct({ ref: refOf("Go to courses"), action: "click" });
	assert.equal(res.navigated, true);
	assert.match(res.url, /\/courses$/);
	assert.equal(res.settled, true);
	assert.match(res.changes.added, /Courses/);
	assert.equal(res.changes.reloaded, undefined);
});

test("real: navegação completa marca reloaded e não compara texto", { skip }, async () => {
	const { refs, page } = await open("/noop");
	await page.evaluate((url) => { document.body.insertAdjacentHTML("beforeend", `<a id="x" href="${url}">Leave</a>`); }, `${fixtures.base}/dest/leave`);
	const snap = await refs.browserSnapshot({});
	const ref = /\[(e\d+)\][^\n]*"Leave"/.exec(snap.lines.join("\n"))[1];
	const res = await refs.browserAct({ ref, action: "click" });
	assert.equal(res.navigated, true);
	assert.equal(res.changes.reloaded, true);
	assert.equal(res.changes.added, undefined);
	assert.equal(res.newTotal, 0);
});

test("real: banner role=alert fora de form nunca vira erro; erro de campo novo vira", { skip }, async () => {
	const { refs, refOf } = await open("/form");
	const banner = await refs.browserAct({ ref: refOf("Banner"), action: "click" });
	assert.equal(banner.errors, undefined);
	const saved = await refs.browserAct({ ref: refOf("Save"), action: "click" });
	assert.ok(saved.errors?.some((e) => /Name is required/.test(e) || /Name:/.test(e)), JSON.stringify(saved.errors));
	assert.ok(!saved.errors.some((e) => /accessibility|Cookie/.test(e)));
});

test("real: browser_click(text) e browser_type devolvem o mesmo diff", { skip }, async () => {
	const { actions } = await open("/accordion");
	const clicked = await actions.browserClick({ text: "Week 3" });
	assert.match(clicked.changes.added, /Unit 03 Intro/);
	assert.ok(clicked.newElements.some((l) => /Unit 03 Intro/.test(l)));
	assert.ok(clicked.waitMs >= 0);
});
