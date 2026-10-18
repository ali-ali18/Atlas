import { test } from "node:test";
import assert from "node:assert/strict";
import { stabilizePage, waitUntilContentReady, waitUntilQuiet, waitUntilSettled } from "./stability.mjs";

function clock() {
	let t = 0;
	return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

test("waitUntilQuiet: termina quando o DOM fica quieto por 300 ms", async () => {
	const c = clock();
	// DOM muda até t=500; depois o idle cresce desde então.
	const readIdleMs = async () => (c.now() < 500 ? 0 : c.now() - 500);
	const result = await waitUntilQuiet({ readIdleMs, now: c.now, sleep: c.sleep });
	assert.equal(result.settled, true);
	assert.ok(result.waitedMs >= 800 && result.waitedMs <= 900, String(result.waitedMs));
});

test("waitUntilQuiet: DOM que nunca para respeita o teto de 4 s", async () => {
	const c = clock();
	const result = await waitUntilQuiet({ readIdleMs: async () => 0, now: c.now, sleep: c.sleep });
	assert.equal(result.settled, false);
	assert.equal(result.waitedMs, 4000);
});

test("waitUntilQuiet: leitura impossível (null, navegando) não conta como quieto", async () => {
	const c = clock();
	let calls = 0;
	const readIdleMs = async () => (++calls < 4 ? null : 1000);
	const result = await waitUntilQuiet({ readIdleMs, now: c.now, sleep: c.sleep });
	assert.equal(result.settled, true);
	assert.equal(calls, 4);
});

test("stabilizePage: informa url/título/navegou/settled sem lançar", async () => {
	const c = clock();
	const page = {
		waitForLoadState: async () => { throw new Error("timeout"); },
		evaluate: async () => { throw new Error("Execution context was destroyed"); },
		url: () => "https://b.com/",
		title: async () => "B",
	};
	const out = await stabilizePage(page, { urlBefore: "https://a.com/", now: c.now, sleep: c.sleep });
	assert.deepEqual(out, { url: "https://b.com/", title: "B", navigated: true, settled: false });
	const quiet = await stabilizePage(
		{ ...page, evaluate: async () => 999 },
		{ urlBefore: "https://b.com/", now: c.now, sleep: c.sleep },
	);
	assert.deepEqual(quiet, { url: "https://b.com/", title: "B", navigated: false, settled: true });
});

test("waitUntilContentReady: texto vazio não é pronto; pronto quando aparece e estabiliza 300 ms", async () => {
	const c = clock();
	const samples = [{ len: 0 }, { len: 0 }, { len: 120 }];
	let i = 0;
	const out = await waitUntilContentReady({
		read: async () => samples[Math.min(i++, samples.length - 1)],
		now: c.now,
		sleep: c.sleep,
	});
	assert.equal(out.ready, true);
	assert.equal(out.textLength, 120);
	assert.ok(out.waitedMs >= 500, `esperou ${out.waitedMs}`); // 200 até o texto + 300 estável
});

test("waitUntilContentReady: texto que cresce reinicia a estabilidade; teto devolve ready:false", async () => {
	const c = clock();
	let len = 0;
	const growing = await waitUntilContentReady({
		read: async () => ({ len: (len += 10) }),
		now: c.now,
		sleep: c.sleep,
		capMs: 1000,
	});
	assert.equal(growing.ready, false);
	assert.ok(growing.waitedMs >= 1000);
	const empty = await waitUntilContentReady({ read: async () => null, now: c.now, sleep: c.sleep, capMs: 500 });
	assert.equal(empty.ready, false);
});

test("waitUntilContentReady: landmark com pouco texto também vale", async () => {
	const c = clock();
	const out = await waitUntilContentReady({ read: async () => ({ len: 12, landmark: true }), now: c.now, sleep: c.sleep });
	assert.equal(out.ready, true);
});

// V4 — espera adaptativa (laço puro, relógio falso)

test("espera: DOM quieto + sem requisição pendente + sem busy -> settled no silêncio mínimo", async () => {
	const c = clock();
	const samples = [
		{ idle: 0, inflight: 0, busy: false },
		{ idle: 60, inflight: 0, busy: false },
		{ idle: 120, inflight: 0, busy: false },
		{ idle: 260, inflight: 0, busy: false },
	];
	const result = await waitUntilSettled({ probe: async () => samples.shift(), ...c });
	assert.equal(result.state, "settled");
	assert.equal(result.waitedMs, 150);
});

test("espera: sem nenhuma atividade desde a ação, a janela curta basta; com atividade espera o silêncio inteiro", async () => {
	const quiet = await waitUntilSettled({ probe: async () => ({ idle: 160, inflight: 0, busy: false, active: false }), ...clock() });
	assert.deepEqual(quiet, { state: "settled", waitedMs: 0 });
	const c = clock();
	const samples = [160, 200, 255].map((idle) => ({ idle, inflight: 0, busy: false, active: true }));
	const active = await waitUntilSettled({ probe: async () => samples.shift(), ...c });
	assert.equal(active.state, "settled");
	assert.equal(active.waitedMs, 100);
});

test("espera: fetch pendente ou aria-busy seguram; teto devolve timeout", async () => {
	const c = clock();
	const held = await waitUntilSettled({
		probe: async () => ({ idle: 5000, inflight: 1, busy: false }),
		capMs: 1000,
		...c,
	});
	assert.equal(held.state, "timeout");
	const c2 = clock();
	const busy = await waitUntilSettled({ probe: async () => ({ idle: 5000, inflight: 0, busy: true }), capMs: 500, ...c2 });
	assert.equal(busy.state, "timeout");
});

test("espera: documento novo (probe fresh/null) vira navigated", async () => {
	const c = clock();
	const a = await waitUntilSettled({ probe: async () => null, ...c });
	assert.equal(a.state, "navigated");
	const seq = [{ idle: 0, inflight: 0, busy: false }, { fresh: true }];
	const b = await waitUntilSettled({ probe: async () => seq.shift(), ...clock() });
	assert.equal(b.state, "navigated");
});

