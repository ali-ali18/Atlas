import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createBrowserActions } from "./browser-actions.mjs";
import {
	CLICK_ERROR_MAX,
	LADDER_TIMEOUTS,
	createClickLadder,
	formatClickError,
	inspectInPage,
} from "./click-ladder.mjs";
import { classifyConsentLabel } from "./consent.mjs";
import { waitForPageReady } from "./stability.mjs";
import { launchFixtureBrowser } from "./test-browser.mjs";

// --- Unidade (página falsa): a ordem dos degraus e os timeouts curtos ---

function fakeTarget({ info, log, clickOk = false, focusOk = false, jsOk = false, mouseOk = false }) {
	const target = {
		click: async (o) => {
			log.push(`click:${o.timeout}`);
			if (!clickOk) throw new Error("locator.click: Timeout 2500ms exceeded.\nCall log:\n  - waiting for element\n  - retrying click action");
		},
		focus: async () => log.push("focus"),
		evaluate: async (fn) => {
			const source = String(fn);
			if (fn.name === "readPointer") return null;
			if (source.includes("activeElement")) return focusOk;
			log.push("js");
			if (!jsOk) throw new Error("detached");
		},
	};
	const locator = {
		evaluate: async (fn) => (fn === inspectInPage ? info : target.evaluate(fn)),
		locator: () => target,
	};
	const page = {
		url: () => "https://x.test/p",
		locator: () => ({ count: async () => 0, first: () => target }),
		keyboard: { press: async (k) => log.push(`press:${k}`) },
		mouse: { click: async () => { log.push("mouse"); if (!mouseOk) throw new Error("mouse failed"); } },
		evaluate: async () => ({ found: false, dismissed: false }),
	};
	return { locator, page };
}

const plainInfo = { visible: true, interactive: true, covered: false, cx: 10, cy: 10, target: { tag: "button" }, blockedByModal: false };

test("escada: degraus em ordem com timeouts curtos e relata qual funcionou", async () => {
	const log = [];
	const { locator, page } = fakeTarget({ info: plainInfo, log, jsOk: true });
	const { clickElement } = createClickLadder();
	const result = await clickElement(page, locator, { label: "Salvar" });
	assert.equal(result.rung, "js");
	assert.deepEqual(result.tried, ["click", "scroll", "keyboard", "js"]);
	// click normal 2,5 s e retry 1,5 s: nunca os 15 s de antes.
	assert.deepEqual(log.filter((l) => l.startsWith("click:")), [`click:${LADDER_TIMEOUTS.click}`, `click:${LADDER_TIMEOUTS.retry}`]);
	assert.ok(LADDER_TIMEOUTS.click <= 3000 && LADDER_TIMEOUTS.retry <= 3000);
	assert.ok(log.indexOf("focus") < log.indexOf("js"));
});

test("escada: tudo falha -> erro compacto (<= 300) sem call log e com o que foi tentado", async () => {
	const log = [];
	const { locator, page } = fakeTarget({ info: plainInfo, log });
	const { clickElement } = createClickLadder();
	const error = await clickElement(page, locator, { label: "Salvar" }).catch((e) => e);
	assert.ok(error instanceof Error);
	assert.ok(error.message.length <= CLICK_ERROR_MAX, `len ${error.message.length}`);
	assert.doesNotMatch(error.message, /Call log|waiting for element|retrying/);
	assert.match(error.message, /Tried: click, scroll, keyboard, js, coords/);
	assert.match(error.message, /browser_act/);
});

test("escada: modal aria-modal que não contém o alvo bloqueia teclado, JS e coordenadas", async () => {
	const log = [];
	const info = { ...plainInfo, covered: true, blockedByModal: true, cover: { tag: "div", role: "dialog", name: "Confirm", interactive: false, containsTarget: false, sameDest: false, consent: false } };
	const { locator, page } = fakeTarget({ info, log, jsOk: true, mouseOk: true });
	const { clickElement } = createClickLadder();
	const error = await clickElement(page, locator, { label: "Salvar" }).catch((e) => e);
	assert.match(error.message, /modal dialog/);
	assert.equal(log.includes("js"), false);
	assert.equal(log.includes("mouse"), false);
	assert.equal(log.includes("focus"), false);
});

test("formatClickError: cita quem cobre e nunca passa de 300 caracteres", () => {
	const message = formatClickError({
		label: "x".repeat(200),
		info: { visible: true, covered: true, cover: { tag: "a", role: "link", name: "n".repeat(60) } },
		tried: ["click", "scroll", "overlay", "keyboard", "js", "coords"],
	});
	assert.ok(message.length <= CLICK_ERROR_MAX);
	assert.match(message, /covered by another element <a role=link/);
});

test("classifyConsentLabel: aceite vence; recusar e fechar são distintos", () => {
	assert.equal(classifyConsentLabel("Accept all"), "accept");
	assert.equal(classifyConsentLabel("Aceitar e fechar"), "accept");
	assert.equal(classifyConsentLabel("Reject all"), "reject");
	assert.equal(classifyConsentLabel("Apenas necessários"), "reject");
	assert.equal(classifyConsentLabel("Tout refuser"), "reject");
	assert.equal(classifyConsentLabel("×"), "close");
	assert.equal(classifyConsentLabel("Preferences"), null);
});

// --- Integração com Chromium real e fixtures HTML locais ---

const overlayPage = `<style>body{margin:0}.card{position:relative;width:300px;height:120px;border:1px solid #333;margin:40px}
.link-overlay{position:absolute;inset:0;z-index:2}</style>
<div class="card"><span id="t">Disciplina Alfa</span><a class="link-overlay" href="/dest/alfa" aria-label="Open Alfa"></a></div>
<a href="/dest/beta" style="margin:40px">Disciplina Beta</a>`;

const ancestorPage = `<body style="margin:40px"><a href="/dest/go"><span>Go there now</span></a></body>`;

const bannerPage = `<body style="margin:0"><button id="go" style="position:absolute;left:420px;top:330px" onclick="location.href='/dest/go'">Go on</button>
<div id="cmp" role="dialog" aria-label="Cookie consent" style="position:fixed;left:100px;top:100px;width:700px;height:500px;background:#eee;z-index:99">
<p>We use cookies to improve your experience.</p>
<button id="acc" onclick="window.accepted=true">Accept all</button>
<button id="rej" onclick="window.rejected=(window.rejected||0)+1;document.getElementById('cmp').style.display='none'">Reject all</button></div></body>`;

const keyboardPage = `<body style="margin:0"><button id="b" style="position:absolute;left:400px;top:300px" onclick="window.hit=(window.hit||0)+1">Save</button>
<div style="position:fixed;inset:0;z-index:5"></div></body>`;

const modalPage = `<body style="margin:0"><button id="b" style="position:absolute;left:400px;top:300px" onclick="window.hit=1">Save</button>
<div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#fff;z-index:9"><p>Please confirm your age</p></div></body>`;

const spaPage = `<body><div id="root"></div><script>setTimeout(()=>{document.getElementById('root').innerHTML='<main><h1>Courses</h1><p>'+'Lorem ipsum dolor sit amet. '.repeat(10)+'</p></main>'},800)</script></body>`;
const noisyPage = `${spaPage}<script>setInterval(()=>document.body.setAttribute('data-t',String(Date.now())),40)</script>`;

const fixtures = await launchFixtureBrowser({
	"/overlay": overlayPage,
	"/ancestor": ancestorPage,
	"/banner": bannerPage,
	"/keyboard": keyboardPage,
	"/modal": modalPage,
	"/spa": spaPage,
	"/noisy": noisyPage,
	"/empty": "<body></body>",
});
after(() => fixtures?.close());
const skip = fixtures ? false : "Chromium/playwright-core indisponível";

async function open(path) {
	const page = await fixtures.newPage();
	await page.goto(`${fixtures.base}${path}`);
	const actions = createBrowserActions({ getPage: async () => page });
	return { page, actions };
}

test("real: título dentro de card com link esticado -> clica no link do card (destino certo, < 5 s)", { skip }, async () => {
	const { page, actions } = await open("/overlay");
	const result = await actions.browserClick({ text: "Disciplina Alfa" });
	assert.equal(result.rung, "overlay");
	assert.match(page.url(), /\/dest\/alfa$/);
	assert.ok(result.clickMs < 5000);
	assert.ok(result.pointer);
});

test("real: texto dentro de <a> sobe ao ancestral interativo e clica de primeira", { skip }, async () => {
	const { page, actions } = await open("/ancestor");
	const result = await actions.browserClick({ text: "Go there now" });
	assert.equal(result.rung, "click");
	assert.deepEqual(result.tried, ["click"]);
	assert.match(result.retargeted, /^<a/);
	assert.match(page.url(), /\/dest\/go$/);
});

test("real: banner de cookies cobre o alvo -> recusa (nunca aceita) e clica", { skip }, async () => {
	const { page, actions } = await open("/banner");
	const result = await actions.browserClick({ selector: "#go" });
	assert.equal(result.rung, "banner");
	assert.equal(result.dismissed, "consent");
	assert.ok(result.clickMs < 5000);
	assert.match(page.url(), /\/dest\/go$/);
});

test("real: o banner é tratado uma vez por página", { skip }, async () => {
	const page = await fixtures.newPage();
	await page.goto(`${fixtures.base}/banner`);
	const { dismissConsentOnce } = createClickLadder();
	assert.equal(await dismissConsentOnce(page), true);
	assert.equal(await page.evaluate(() => window.rejected), 1);
	assert.equal(await page.evaluate(() => window.accepted), undefined);
	await page.evaluate(() => { document.getElementById("cmp").style.display = "block"; });
	assert.equal(await dismissConsentOnce(page), false);
	assert.equal(await page.evaluate(() => window.rejected), 1);
});

test("real: coberto por elemento não interativo -> teclado (foco + Enter)", { skip }, async () => {
	const { page, actions } = await open("/keyboard");
	const result = await actions.browserClick({ selector: "#b" });
	assert.equal(result.rung, "keyboard");
	assert.deepEqual(result.tried, ["keyboard"]);
	assert.equal(await page.evaluate(() => window.hit), 1);
});

test("real: modal alheio -> erro compacto, sem JS click e sem log do Playwright", { skip }, async () => {
	const { page, actions } = await open("/modal");
	const started = Date.now();
	const error = await actions.browserClick({ selector: "#b" }).catch((e) => e);
	assert.ok(error instanceof Error);
	assert.ok(error.message.length <= CLICK_ERROR_MAX);
	assert.match(error.message, /modal dialog/);
	assert.doesNotMatch(error.message, /Call log/);
	assert.equal(await page.evaluate(() => window.hit), undefined);
	assert.ok(Date.now() - started < 5000);
});

test("real: SPA com conteúdo atrasado -> navigate espera o texto (não devolve [0-0])", { skip }, async () => {
	const page = await fixtures.newPage();
	const actions = createBrowserActions({ getPage: async () => page });
	const result = await actions.navigate(`${fixtures.base}/spa`);
	assert.equal(result.ready, true);
	assert.ok(result.textLength >= 40, `texto ${result.textLength}`);
	assert.ok(result.readyMs >= 600, `esperou ${result.readyMs} ms`);
	assert.ok(typeof result.gotoMs === "number");
	assert.ok(/destination|Courses/.test(await page.evaluate(() => document.body.innerText)));
});

test("real: DOM que muta sem parar não segura a prontidão (mede o texto, não mutações)", { skip }, async () => {
	const page = await fixtures.newPage();
	const actions = createBrowserActions({ getPage: async () => page });
	const result = await actions.navigate(`${fixtures.base}/noisy`);
	assert.equal(result.ready, true);
	assert.ok(result.readyMs < 2500, `readyMs ${result.readyMs}`);
});

test("real: página que nunca ganha conteúdo -> ready:false com dica, no teto", { skip }, async () => {
	const page = await fixtures.newPage();
	const actions = createBrowserActions({
		getPage: async () => page,
		ready: (p) => waitForPageReady(p, { capMs: 700 }),
	});
	const result = await actions.navigate(`${fixtures.base}/empty`);
	assert.equal(result.ready, false);
	assert.equal(result.settled, false);
	assert.match(result.hint, /still rendering/);
	assert.ok(result.readyMs < 2000);
});
