import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createBrowserActions } from "./browser-actions.mjs";
import { createRefActions, parseWaitArgs } from "./browser-refs.mjs";
import { waitUntilTextStable } from "./text-stable.mjs";
import { launchFixtureBrowser } from "./test-browser.mjs";

function fakeClock() {
	let t = 0;
	return { now: () => t, sleep: async (ms) => void (t += ms) };
}

test("waitUntilTextStable: conclui depois de quietMs sem mudança do texto", async () => {
	const clock = fakeClock();
	// O texto mexe até 2000 ms; a partir daí fica parado.
	const sample = async () => ({ found: true, changed: true, idleMs: Math.max(0, clock.now() - 2000), len: 40 });
	const res = await waitUntilTextStable({ sample, capMs: 20_000, ...clock });
	assert.equal(res.met, true);
	assert.ok(res.waitedMs >= 3500 && res.waitedMs <= 3800, `waitedMs=${res.waitedMs}`);
});

test("waitUntilTextStable: nada mudou -> dá o tempo de graça antes de concluir", async () => {
	const clock = fakeClock();
	const sample = async () => ({ found: true, changed: false, idleMs: clock.now(), len: 0 });
	const res = await waitUntilTextStable({ sample, capMs: 20_000, ...clock });
	assert.equal(res.met, true);
	assert.equal(res.changed, false);
	assert.ok(res.waitedMs >= 3000 && res.waitedMs < 3400);
});

test("waitUntilTextStable: texto que nunca para estoura o teto com motivo honesto", async () => {
	const clock = fakeClock();
	const sample = async () => ({ found: true, changed: true, idleMs: 0, len: 10 });
	const res = await waitUntilTextStable({ sample, capMs: 2000, ...clock });
	assert.equal(res.met, false);
	assert.match(res.reason, /continuou mudando/);
	assert.ok(res.waitedMs <= 2250);
});

test("waitUntilTextStable: alvo ausente -> não encontrado", async () => {
	const clock = fakeClock();
	const res = await waitUntilTextStable({ sample: async () => ({ found: false, changed: false, len: 0 }), capMs: 1000, ...clock });
	assert.equal(res.met, false);
	assert.match(res.reason, /alvo não encontrado/);
});

test("parseWaitArgs: text_stable aceita ref ou scope, teto padrão de 20 s", () => {
	const plain = parseWaitArgs({ for: "text_stable" });
	assert.equal(plain.timeoutMs, 20_000);
	assert.equal(plain.ref, undefined);
	assert.equal(parseWaitArgs({ for: "text_stable", ref: "f1e4" }).ref, "f1e4");
	assert.equal(parseWaitArgs({ for: "text_stable", scope: "#answer" }).scope, "#answer");
	assert.throws(() => parseWaitArgs({ for: "text_stable", ref: "div" }), /ref inválido/);
});

// Resposta que cresce a cada 200 ms por 2 s; um relógio (mesmo tamanho) e um "player" mudam sem parar.
const stream = `<body style="margin:12px"><h1>Chat</h1><button id="b" onclick="void 0">Ask</button>
<div id="answer"><p id="txt">Answer:</p></div>
<div class="video-player"><span id="t">0</span></div><div><span id="clock">00:00</span></div>
<script>
let n = 0; const txt = document.getElementById('txt');
const iv = setInterval(() => { n += 1; txt.textContent += ' word' + n; if (n >= 10) clearInterval(iv); }, 200);
let c = 0; setInterval(() => { c += 1; document.getElementById('t').textContent = String(c * 7919); document.getElementById('clock').textContent = String(10000 + (c % 9000)).slice(0, 5); }, 40);
</script></body>`;

const fixtures = await launchFixtureBrowser({ "/stream": stream });
after(() => fixtures?.close());
const skip = fixtures ? false : "Chromium/playwright-core indisponível";

async function open() {
	const page = await fixtures.newPage();
	await page.goto(`${fixtures.base}/stream`);
	const actions = createBrowserActions({ getPage: async () => page });
	const refs = createRefActions({ withPageRetry: actions.withPageRetry, clickElement: actions.clickElement, axOn: () => false });
	actions.setObserver(refs.observeAction);
	return { page, refs };
}

test("real: text_stable (sem alvo) termina depois que o texto para, ignorando player e relógio", { skip }, async () => {
	const { refs } = await open();
	const started = Date.now();
	const res = await refs.browserWait({ for: "text_stable", timeoutMs: 15_000 });
	const took = Date.now() - started;
	assert.equal(res.met, true, JSON.stringify(res));
	assert.equal(res.changed, true);
	// 2 s de texto crescendo + ~1,5 s quieto; bem abaixo do teto.
	assert.ok(took >= 3000, `terminou cedo demais (${took} ms)`);
	assert.ok(took < 8000, `demorou demais (${took} ms)`);
});

test("real: text_stable por scope e por ref olha só o alvo", { skip }, async () => {
	const { refs, page } = await open();
	const scoped = await refs.browserWait({ for: "text_stable", scope: "#answer", timeoutMs: 15_000 });
	assert.equal(scoped.met, true, JSON.stringify(scoped));
	assert.equal(await page.locator("#txt").innerText(), "Answer: word1 word2 word3 word4 word5 word6 word7 word8 word9 word10");
	const snap = await refs.browserSnapshot({});
	const ref = /\[(e\d+)\]/.exec(snap.lines.find((l) => l.includes('"Ask"')))[1];
	const byRef = await refs.browserWait({ for: "text_stable", ref, timeoutMs: 15_000 });
	assert.equal(byRef.met, true, JSON.stringify(byRef));
});

test("real: text_stable com teto curto e texto que cresce devolve met:false e o motivo", { skip }, async () => {
	const { refs } = await open();
	const res = await refs.browserWait({ for: "text_stable", scope: "#answer", timeoutMs: 600 });
	assert.equal(res.met, false);
	assert.match(res.reason, /continuou mudando|não ocorreu/);
	assert.ok(res.waitedMs < 1500);
});
