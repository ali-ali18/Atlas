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

test("Chrome pendurado (evaluate não responde) é morto, relançado e reconectado", async () => {
	const log = [];
	let clock = 0;
	const hung = { isClosed: () => false, evaluate: () => new Promise(() => {}) };
	const fresh = { isClosed: () => false, evaluate: async () => 1 };
	let connections = 0;
	const makeBrowser = (page) => ({
		isConnected: () => true,
		close: async () => log.push("close"),
		contexts: () => [{ pages: () => [page] }],
	});
	const session = createBrowserSession({
		cdpUrl: "http://127.0.0.1:9222",
		now: () => clock,
		wait: async () => {},
		kill: async () => log.push("kill"),
		launch: async () => log.push("launch"),
		chromium: {
			connectOverCDP: async () => {
				connections += 1;
				// 1ª conexão: Chrome pendurado; depois do kill/launch: Chrome novo.
				return makeBrowser(log.includes("launch") || connections > 1 ? fresh : hung);
			},
		},
	});
	assert.equal(await session.getPage(), hung); // primeira vez: sem health-check ainda
	clock += 10_000;
	// Agora o health-check roda, estoura o timeout de 3 s e reinicia.
	const page = await session.getPage();
	assert.equal(page, fresh);
	assert.deepEqual(log.filter((l) => l !== "close"), ["kill"]);
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
