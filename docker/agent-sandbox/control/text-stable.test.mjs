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
	// 2000 (último movimento) + 1500 de silêncio + 1000 de confirmação.
	assert.ok(res.waitedMs >= 4500 && res.waitedMs <= 4800, `waitedMs=${res.waitedMs}`);
});

test("waitUntilTextStable: pausa de 2 s no meio do streaming não encerra a espera", async () => {
	const clock = fakeClock();
	// Cresce até 1000 ms, pausa até 3000 ms, cresce de novo até 4000 ms e para.
	const lastChange = () => {
		const t = clock.now();
		if (t >= 4000) return 4000;
		if (t >= 3000) return t;
		return Math.min(t, 1000);
	};
	const sample = async () => ({ found: true, changed: true, idleMs: clock.now() - lastChange(), len: 40 });
	const res = await waitUntilTextStable({ sample, capMs: 30_000, ...clock });
	assert.equal(res.met, true);
	assert.ok(res.waitedMs >= 4000 + 2500 && res.waitedMs <= 4000 + 2800, `waitedMs=${res.waitedMs}`);
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

// 15 mil comentários (8 mil ocultos no começo) antes de um painel lateral que streama com uma pausa de 2 s
// no meio. Um bloco OCULTO também muda sem parar: não pode contar. Fim do stream em ~3,2 s.
const feedStream = `<body style="margin:0"><div hidden id="hid"></div><div style="display:none" id="hid2"></div><div id="comments"></div>
<aside style="position:fixed;right:0;top:0;width:260px;background:#eee"><p id="ans">Resposta:</p></aside>
<script>
document.getElementById('hid2').innerHTML = Array.from({ length: 8000 }, (_, i) => '<p>oculto '+i+'</p>').join('');
document.getElementById('comments').innerHTML = Array.from({ length: 15000 }, (_, i) => '<p>Comment '+i+' about nothing</p>').join('');
let h = 0; setInterval(() => { h += 1; document.getElementById('hid').textContent += ' x'.repeat(h % 7 + 1); }, 60);
const words = ['um','dois','tres','quatro','cinco','seis','sete','oito','nove','FIM'];
let n = 0;
function next() {
  if (n >= words.length) return;
  document.getElementById('ans').textContent += ' ' + words[n++];
  setTimeout(next, n === 5 ? 2000 : 200);
}
setTimeout(next, 100);
</script></body>`;

// Chat que gera ~2 s de texto com o botão "Parar resposta" visível e o remove no fim (aria-busy volta a false).
const genStop = `<body><main id="box" aria-busy="true"><div id="out"></div></main><button id="stop" aria-label="Parar resposta">■</button>
<script>
let n = 0;
const t = setInterval(() => {
  document.getElementById('out').textContent += ' palavra' + (++n);
  if (n >= 10) { clearInterval(t); setTimeout(() => { document.getElementById('stop').remove(); document.getElementById('box').setAttribute('aria-busy', 'false'); }, 150); }
}, 200);
</script></body>`;
// Mesma geração, mas com pausa de 2,5 s no meio e o botão de parar sempre visível até o fim.
const genPause = `<body><div id="out"></div><button id="stop" aria-label="Stop generating">x</button>
<script>
let n = 0;
function next() {
  document.getElementById('out').textContent += ' w' + (++n);
  if (n === 5) return setTimeout(next, 2500);
  if (n >= 8) return setTimeout(() => document.getElementById('stop').remove(), 100);
  setTimeout(next, 200);
}
next();
</script></body>`;

// aria-busy de um spinner alheio (cabeçalho, fora do escopo da resposta) some antes de a resposta começar.
const foreignSpinner = `<body><header><div><span id="sp" aria-busy="true">carregando</span></div></header>
<div id="app"><section><div><div><p id="ans">Resposta:</p></div></div></section></div>
<script>
setTimeout(() => document.getElementById('sp').setAttribute('aria-busy', 'false'), 300);
const words = ['um','dois','tres','quatro','FIM'];
let n = 0;
function next() { document.getElementById('ans').textContent += ' ' + words[n++]; if (n < words.length) setTimeout(next, 300); }
setTimeout(next, 1500);
</script></body>`;
// Botão de parar visível, some por 1 s no meio (re-render) e volta; some de vez no fim.
const genBlink = `<body><div id="app"><section><div><div><p id="out">x</p></div></div></section></div><button id="stop" aria-label="Parar resposta">■</button>
<script>
const out = document.getElementById('out'); const stop = document.getElementById('stop');
let n = 0;
function add() { out.textContent += ' w' + (++n); }
const iv = setInterval(add, 200);
setTimeout(() => { clearInterval(iv); stop.style.display = 'none'; }, 1000);
setTimeout(() => { stop.style.display = ''; add(); }, 2000);
setTimeout(() => { add(); stop.remove(); }, 2300);
</script></body>`;

const fixtures = await launchFixtureBrowser({ "/foreign": foreignSpinner, "/blink": genBlink, "/stream": stream, "/feedstream": feedStream, "/genstop": genStop, "/genpause": genPause });
after(() => fixtures?.close());
const skip = fixtures ? false : "Chromium/playwright-core indisponível";

async function open(path = "/stream") {
	const page = await fixtures.newPage();
	await page.goto(`${fixtures.base}${path}`);
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

test("real: painel que streama atrás de 15 mil comentários, com pausa de 2 s: a espera só acaba no fim", { skip }, async () => {
	const { refs, page } = await open("/feedstream");
	const started = Date.now();
	const res = await refs.browserWait({ for: "text_stable", timeoutMs: 20_000 });
	const took = Date.now() - started;
	const text = await page.locator("#ans").innerText();
	assert.equal(res.met, true, JSON.stringify(res));
	assert.equal(res.changed, true, "o streaming do painel foi visto (não é só o prazo de graça)");
	// O painel acabou de receber a última palavra: nada foi cortado pela pausa nem pelo bloco oculto que muda sempre.
	assert.match(text, /FIM$/);
	// 1 s + pausa de 2 s + 1,2 s de streaming + 2,5 s de silêncio/confirmação; folga para a carga da página.
	assert.ok(took >= 5500, `terminou cedo demais (${took} ms)`);
	assert.ok(took < 12_000, `demorou demais (${took} ms)`);
});

test("waitUntilTextStable: sinal de fim (botão de parar sumiu) encerra antes do silêncio completo", async () => {
	const clock = fakeClock();
	const sample = async () => ({ found: true, changed: true, idleMs: Math.max(0, clock.now() - 2000), len: 40, ended: clock.now() >= 2100 });
	const res = await waitUntilTextStable({ sample, capMs: 20_000, ...clock });
	assert.equal(res.met, true);
	assert.equal(res.endSignal, true);
	assert.ok(res.waitedMs >= 3200 && res.waitedMs < 4000, `waitedMs=${res.waitedMs}`);
	// Sem o sinal, o mesmo texto só conclui no silêncio + confirmação.
	const clock2 = fakeClock();
	const slow = await waitUntilTextStable({ sample: async () => ({ found: true, changed: true, idleMs: Math.max(0, clock2.now() - 2000), len: 40 }), capMs: 20_000, ...clock2 });
	assert.ok(slow.waitedMs >= 4500);
	assert.equal(slow.endSignal, undefined);
});

test("waitUntilTextStable: sinal de fim sem o texto ter mudado nunca encerra antes da graça", async () => {
	const clock = fakeClock();
	const sample = async () => ({ found: true, changed: false, idleMs: clock.now(), len: 0, ended: true });
	const res = await waitUntilTextStable({ sample, capMs: 20_000, ...clock });
	assert.equal(res.endSignal, undefined);
	assert.ok(res.waitedMs >= 3000);
});

test("waitUntilTextStable: sinal de fim que some e volta em 1 s (re-render) não encerra", async () => {
	const clock = fakeClock();
	// Texto parado desde 500 ms; sinal "terminado" só entre 1000 e 2000 ms, depois o botão volta até 6000 ms.
	const sample = async () => {
		const t = clock.now();
		const ended = (t >= 1000 && t < 2000) || t >= 6000;
		return { found: true, changed: true, idleMs: Math.max(0, t - 500), len: 40, ended };
	};
	const res = await waitUntilTextStable({ sample, capMs: 20_000, ...clock });
	assert.equal(res.met, true);
	// Encerra pelo silêncio normal (500 + 2500), não pelo sinal de 1 s que sumiu e voltou.
	assert.equal(res.endSignal, undefined);
	assert.ok(res.waitedMs >= 2900, `waitedMs=${res.waitedMs}`);
});

test("real: botão de parar removido (e aria-busy=false) termina a espera cedo, sem passar do teto", { skip }, async () => {
	const { refs } = await open("/genstop");
	const started = Date.now();
	const res = await refs.browserWait({ for: "text_stable", timeoutMs: 15_000 });
	const took = Date.now() - started;
	assert.equal(res.met, true, JSON.stringify(res));
	assert.equal(res.endSignal, true, JSON.stringify(res));
	// ~2,2 s de geração + ~0,4 s: o silêncio completo (2,5 s) só acabaria depois de ~4,7 s.
	assert.ok(took < 4200, `demorou ${took} ms`);
});

test("real: pausa longa com o botão de parar ainda visível não encerra a espera", { skip }, async () => {
	const { refs, page } = await open("/genpause");
	const res = await refs.browserWait({ for: "text_stable", timeoutMs: 15_000 });
	assert.equal(res.met, true, JSON.stringify(res));
	assert.equal(await page.locator("#out").innerText(), "w1 w2 w3 w4 w5 w6 w7 w8");
});

test("real: aria-busy de spinner alheio que some antes da resposta NÃO encerra cedo", { skip }, async () => {
	const { refs, page } = await open("/foreign");
	const res = await refs.browserWait({ for: "text_stable", timeoutMs: 15_000 });
	assert.equal(res.met, true, JSON.stringify(res));
	assert.equal(res.endSignal, undefined, JSON.stringify(res));
	assert.match(await page.locator("#ans").innerText(), /FIM$/);
});

test("real: botão de parar que some e volta (pausa de 1 s) não encerra cedo", { skip }, async () => {
	const { refs, page } = await open("/blink");
	const res = await refs.browserWait({ for: "text_stable", scope: "#out", timeoutMs: 15_000 });
	assert.equal(res.met, true, JSON.stringify(res));
	const text = await page.locator("#out").innerText();
	assert.match(text, /w5 w6 w7$/, text);
});
