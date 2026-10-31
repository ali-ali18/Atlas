import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserActions } from "./browser-actions.mjs";
import { createBrowserSession } from "./browser-session.mjs";
import { launchFixtureBrowser } from "./test-browser.mjs";

const page = { waitForLoadState: async () => {} };

function actions({ alive, log }) {
	return createBrowserActions({
		getPage: async () => page,
		restart: async () => { log.push("restart"); },
		browserAlive: () => alive,
		wait: async () => {},
	});
}

test("aba fechada com o Chrome vivo: pega a página de novo, sem reiniciar", async () => {
	const log = [];
	let calls = 0;
	const { withPageRetry } = actions({ alive: true, log });
	const out = await withPageRetry(async () => {
		calls += 1;
		if (calls === 1) throw new Error("page.waitForTimeout: Target page, context or browser has been closed");
		return "ok";
	}, { tries: 2 });
	assert.equal(out, "ok");
	assert.deepEqual(log, []);
});

test("Chrome desconectado de verdade: reinicia como antes", async () => {
	const log = [];
	let calls = 0;
	const { withPageRetry } = actions({ alive: false, log });
	const out = await withPageRetry(async () => {
		calls += 1;
		if (calls === 1) throw new Error("Target page, context or browser has been closed");
		return "ok";
	}, { tries: 2 });
	assert.equal(out, "ok");
	assert.deepEqual(log, ["restart"]);
});

test("com o Chrome vivo só há uma nova tentativa suave; a segunda falha reinicia", async () => {
	const log = [];
	let calls = 0;
	const { withPageRetry } = actions({ alive: true, log });
	const out = await withPageRetry(async () => {
		calls += 1;
		if (calls <= 2) throw new Error("Target closed");
		return "ok";
	}, { tries: 3 });
	assert.equal(out, "ok");
	assert.deepEqual(log, ["restart"]);
});

test("Chromium real: popup que se fecha sozinho no meio da ação não reinicia o Chrome nem perde as abas", async (t) => {
	const fixture = await launchFixtureBrowser({
		"/curso": '<html><title>Curso</title><body><a id="pay" href="/pagar" target="_blank">Pagar</a></body></html>',
		"/pagar": "<html><title>Pagar</title><body>ok<script>setTimeout(() => window.close(), 400)</script></body></html>",
	});
	if (!fixture) return t.skip("Chromium indisponível");
	try {
		const seed = await fixture.newPage();
		await seed.goto(`${fixture.base}/curso`);
		const context = seed.context();
		const session = createBrowserSession({
			cdpUrl: "http://127.0.0.1:9222",
			chromium: { connectOverCDP: async () => ({ isConnected: () => true, contexts: () => [context], close: async () => {} }) },
		});
		let restarts = 0;
		const { withPageRetry } = createBrowserActions({
			getPage: () => session.getPage(),
			restart: async () => { restarts += 1; },
			browserAlive: () => session.isConnected(),
			wait: async () => {},
		});
		await session.getPage();
		await seed.click("#pay");
		let attempt = 0;
		// A ação roda na aba do popup, que se fecha enquanto ela espera.
		const url = await withPageRetry(async (p) => {
			attempt += 1;
			if (attempt === 1) await p.waitForTimeout(3000);
			return p.url();
		}, { tries: 2 });
		assert.equal(attempt, 2);
		assert.equal(restarts, 0);
		assert.match(url, /\/curso$/);
		assert.equal(context.pages().length, 1);
		assert.match(session.takeNotice() ?? "", /The tab you were on was closed/);
	} finally {
		await fixture.close();
	}
});
