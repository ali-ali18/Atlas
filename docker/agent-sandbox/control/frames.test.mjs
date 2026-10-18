import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFrameRegistry, frameTag, splitRef } from "./frames.mjs";
import { createBrowserActions } from "./browser-actions.mjs";
import { createRefActions, parseActArgs } from "./browser-refs.mjs";
import { launchFixtureBrowser } from "./test-browser.mjs";

test("splitRef: separa o prefixo do frame do número", () => {
	assert.deepEqual(splitRef("e12"), { prefix: "", seq: 12 });
	assert.deepEqual(splitRef("f2e7"), { prefix: "f2", seq: 7 });
	assert.equal(splitRef("x1"), null);
	assert.equal(splitRef("f2"), null);
});

test("parseActArgs aceita ref com prefixo de frame", () => {
	assert.equal(parseActArgs({ ref: "f1e12", action: "click" }).ref, "f1e12");
	assert.throws(() => parseActArgs({ ref: "f1x12", action: "click" }), /ref inválido/);
});

test("registry: prefixos estáveis, outra origem marcada, frame desanexado some", () => {
	const mk = (url, name = "") => ({ url: () => url, name: () => name, isDetached: () => false });
	const main = mk("http://a.test/");
	const same = mk("http://a.test/inner", "lms");
	const cross = mk("https://cdn.other.test/player");
	const dead = { ...mk("http://a.test/x"), isDetached: () => true };
	const page = { mainFrame: () => main, frames: () => [main, same, cross, dead] };
	const reg = createFrameRegistry();
	const entries = reg.list(page);
	assert.deepEqual(entries.map((e) => e.prefix), ["", "f1", "f2"]);
	assert.equal(frameTag(entries[1]), "lms");
	assert.equal(frameTag(entries[2]), "/player other-origin cdn.other.test");
	assert.equal(reg.list(page)[1].prefix, "f1", "estável entre chamadas");
	assert.equal(reg.frameOf(page, "f2"), cross);
	assert.equal(reg.frameOf(page, "f9"), null);
	assert.equal(reg.frameOf(page, ""), main);
});

const host = `<body style="margin:10px"><h1>Course</h1><p>Main text</p>
<iframe id="same" src="/inner" width="400" height="120"></iframe>
<script>document.body.insertAdjacentHTML('beforeend','<iframe id="cross" src="http://localhost:'+location.port+'/inner2" width="400" height="120"></iframe>')</script>
<div id="host"></div>
<script>const r=document.getElementById('host').attachShadow({mode:'open'});r.innerHTML='<h2>Shadow title</h2><p>Shadow paragraph text</p><button onclick="this.insertAdjacentHTML(&quot;afterend&quot;,&quot;<p>Shadow clicked</p>&quot;)">Shadow action</button>'</script></body>`;
const inner = (word) => `<body style="margin:4px"><p>${word} text</p><button onclick="document.body.insertAdjacentHTML('beforeend','<p>${word} clicked</p>')">${word} action</button></body>`;

const fixtures = await launchFixtureBrowser({ "/host": host, "/inner": inner("Inner"), "/inner2": inner("Cross") });
after(() => fixtures?.close());
const skip = fixtures ? false : "Chromium/playwright-core indisponível";

async function open() {
	const page = await fixtures.newPage();
	await page.goto(`${fixtures.base}/host`);
	await page.waitForLoadState("load");
	await page.waitForFunction(() => document.querySelectorAll("iframe").length === 2);
	for (const frame of page.frames()) await frame.waitForLoadState("domcontentloaded").catch(() => {});
	const actions = createBrowserActions({ getPage: async () => page });
	const refs = createRefActions({ withPageRetry: actions.withPageRetry, clickElement: actions.clickElement });
	actions.setObserver(refs.observeAction);
	const snap = await refs.browserSnapshot({});
	const lineOf = (label) => {
		const line = snap.lines.find((l) => l.includes(`"${label}"`));
		assert.ok(line, `"${label}" no snapshot: ${snap.lines.join(" / ")}`);
		return line;
	};
	const refOf = (label) => /\[((?:f\d+)?e\d+)\]/.exec(lineOf(label))[1];
	return { page, refs, snap, lineOf, refOf };
}

test("real: o snapshot lista iframes (mesma e outra origem) e shadow DOM, com ref por frame", { skip }, async () => {
	const { lineOf, refOf } = await open();
	assert.match(refOf("Inner action"), /^f\d+e\d+$/);
	assert.match(refOf("Cross action"), /^f\d+e\d+$/);
	assert.notEqual(refOf("Inner action").split("e")[0], refOf("Cross action").split("e")[0]);
	assert.match(lineOf("Cross action"), /other-origin localhost/);
	assert.doesNotMatch(lineOf("Inner action"), /other-origin/);
	assert.match(refOf("Shadow action"), /^e\d+$/, "shadow do frame principal não tem prefixo");
});

test("real: clicar num ref de iframe age no frame certo e o diff traz o texto do frame", { skip }, async () => {
	const { refs, refOf } = await open();
	const res = await refs.browserAct({ ref: refOf("Inner action"), action: "click" });
	assert.equal(res.ok, true);
	assert.match(res.changes.added, /Inner clicked/);
	const cross = await refs.browserAct({ ref: refOf("Cross action"), action: "click" });
	assert.match(cross.changes.added, /Cross clicked/);
});

test("real: clicar num botão dentro de shadow root funciona e o diff vê o texto novo", { skip }, async () => {
	const { refs, refOf } = await open();
	const res = await refs.browserAct({ ref: refOf("Shadow action"), action: "click" });
	assert.match(res.changes.added, /Shadow clicked/);
});

test("real: ref de frame inexistente falha com dica, sem agir em outro frame", { skip }, async () => {
	const { refs } = await open();
	await assert.rejects(() => refs.browserAct({ ref: "f9e1", action: "click" }), /não encontrado/);
});

test("real: pointer de elemento em iframe de outra origem soma o deslocamento do frame", { skip }, async () => {
	const { refs, refOf, page } = await open();
	const sameRef = refOf("Inner action");
	const crossRef = refOf("Cross action");
	const same = await refs.browserAct({ ref: sameRef, action: "hover" });
	const cross = await refs.browserAct({ ref: crossRef, action: "hover" });
	for (const res of [same, cross]) {
		assert.ok(res.pointer && Number.isFinite(res.pointer.x) && Number.isFinite(res.pointer.y), JSON.stringify(res.pointer));
		assert.equal(res.pointer.partial, undefined);
	}
	// Verdade de referência: o Playwright dá a caixa em coordenadas da janela, qualquer que seja o frame.
	const center = async (ref) => {
		const box = await (await refs.locateRef(page, ref)).boundingBox();
		return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	};
	const a = await center(sameRef);
	const b = await center(crossRef);
	assert.ok(Math.abs(cross.pointer.x - same.pointer.x - (b.x - a.x)) <= 2, `dx ${cross.pointer.x - same.pointer.x} vs ${b.x - a.x}`);
	assert.ok(Math.abs(cross.pointer.y - same.pointer.y - (b.y - a.y)) <= 2, `dy ${cross.pointer.y - same.pointer.y} vs ${b.y - a.y}`);
	assert.equal(cross.pointer.screenW, same.pointer.screenW, "a tela é a da janela principal, não a do iframe");
});
