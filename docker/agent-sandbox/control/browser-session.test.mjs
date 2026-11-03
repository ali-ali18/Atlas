import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserSession, isChromeDeadError, shouldRetryPlaywrightError } from "./browser-session.mjs";

test("shouldRetryPlaywrightError: só navegação em andamento tenta de novo", () => {
	assert.equal(shouldRetryPlaywrightError("Execution context was destroyed, page navigated"), true);
	assert.equal(shouldRetryPlaywrightError("waiting for selector: navigating to another page"), true);
	assert.equal(shouldRetryPlaywrightError("Timeout 15000ms exceeded"), false);
	assert.equal(shouldRetryPlaywrightError("selector ou text é obrigatório"), false);
	assert.equal(shouldRetryPlaywrightError(undefined), false);
});

test("closed page is replaced within the same context", async () => {
	let closed = false;
	const first = { isClosed: () => closed };
	const second = { isClosed: () => false };
	const browser = { isConnected: () => true, contexts: () => [{
		pages: () => [first], newPage: async () => second,
	}] };
	const session = createBrowserSession({ cdpUrl: "http://127.0.0.1:9222",
		chromium: { connectOverCDP: async () => browser } });
	assert.equal(await session.getPage(), first);
	closed = true;
	assert.equal(await session.getPage(), second);
});

test("simultaneous requests share browser recovery", async () => {
	let started = 0;
	const page = { isClosed: () => false };
	const session = createBrowserSession({ cdpUrl: "http://127.0.0.1:9222",
		launch: async () => { started++; }, wait: async () => {},
		chromium: { connectOverCDP: async () => {
			if (!started) throw new Error("ECONNREFUSED");
			return { isConnected: () => true, contexts: () => [{ pages: () => [page] }] };
		} } });
	assert.deepEqual(await Promise.all([session.getPage(), session.getPage()]), [page, page]);
	assert.equal(started, 1);
});

test("unavailable browser fails after bounded retries and can recover later", async () => {
	let calls = 0;
	let available = false;
	const page = { isClosed: () => false };
	const session = createBrowserSession({ cdpUrl: "http://127.0.0.1:9222",
		launch: async () => {}, wait: async () => {}, attempts: 2,
		chromium: { connectOverCDP: async () => {
			calls++;
			if (!available) throw new Error("ECONNREFUSED");
			return { isConnected: () => true, contexts: () => [{ pages: () => [page] }] };
		} } });
	await assert.rejects(session.getPage(), /Chrome indisponível/);
	assert.equal(calls, 3);
	available = true;
	assert.equal(await session.getPage(), page);
});

test("isChromeDeadError: Chrome morto sim; seletor/timeout de página não", () => {
	assert.equal(isChromeDeadError("Target page, context or browser has been closed"), true);
	assert.equal(isChromeDeadError("browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9222"), true);
	assert.equal(isChromeDeadError("Timeout 15000ms exceeded waiting for selector"), false);
});

function hangingHarness({ slowBrowserProbe }) {
	const log = [];
	let clock = 0;
	let probes = 0;
	const page = { isClosed: () => false, evaluate: () => new Promise(() => {}) };
	const cdp = { send: async () => { probes += 1; if (slowBrowserProbe()) await new Promise(() => {}); return {}; }, detach: async () => {} };
	const makeBrowser = () => ({
		isConnected: () => true,
		close: async () => log.push("close"),
		newBrowserCDPSession: async () => cdp,
		contexts: () => [{ pages: () => [page] }],
	});
	const session = createBrowserSession({
		cdpUrl: "http://127.0.0.1:9222",
		now: () => clock,
		healthTimeoutMs: 20,
		wait: async () => {},
		kill: async () => log.push("kill"),
		launch: async () => log.push("launch"),
		chromium: { connectOverCDP: async () => makeBrowser() },
	});
	return { session, log, page, tick: (ms) => { clock += ms; }, probes: () => probes };
}

test("aba pesada (evaluate preso) com o Chrome respondendo NÃO reinicia o Chrome", async () => {
	const h = hangingHarness({ slowBrowserProbe: () => false });
	await h.session.getPage();
	for (let i = 0; i < 5; i += 1) {
		h.tick(10_000);
		assert.equal(await h.session.getPage(), h.page);
	}
	assert.deepEqual(h.log, []);
	assert.ok(h.probes() >= 5, "a sonda é o CDP do navegador, não o evaluate da aba");
});

test("Chrome sem resposta: reinicia só após falhas seguidas e com teto por janela (sem laço)", async () => {
	const h = hangingHarness({ slowBrowserProbe: () => true });
	await h.session.getPage();
	h.tick(10_000);
	await h.session.getPage(); // 1ª falha: segue com a aba, sem matar
	assert.deepEqual(h.log, []);
	h.tick(10_000);
	await h.session.getPage(); // 2ª falha seguida: reinicia
	assert.deepEqual(h.log.filter((l) => l !== "close"), ["kill"]);
	// Chrome continua mudo: no máximo MAX_AUTO_RESTARTS por janela e 30 s entre reinícios.
	for (let i = 0; i < 40; i += 1) {
		h.tick(10_000);
		await h.session.getPage();
	}
	const restarts = h.log.filter((l) => l === "kill").length;
	assert.ok(restarts <= 3, `reiniciou ${restarts}x em ~400 s`);
	assert.match(h.session.takeNotice() ?? "", /slow to respond|restart limit/);
});

test("restart() mata, relança e devolve página nova com o mesmo perfil", async () => {
	const log = [];
	const page = { isClosed: () => false, evaluate: async () => 1 };
	let alive = true;
	const session = createBrowserSession({
		cdpUrl: "http://127.0.0.1:9222",
		wait: async () => {},
		kill: async () => { alive = false; log.push("kill"); },
		launch: async () => { alive = true; log.push("launch"); },
		chromium: {
			connectOverCDP: async () => {
				if (!alive) throw new Error("ECONNREFUSED");
				return { isConnected: () => true, close: async () => {}, contexts: () => [{ pages: () => [page] }] };
			},
		},
	});
	await session.getPage();
	assert.equal(await session.restart(), page);
	assert.deepEqual(log, ["kill", "launch"]);
});
