import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserSession } from "./browser-session.mjs";
import { createTabScope, parseTabHeader, MAX_CHILD_TABS } from "./browser-tabs.mjs";
import { launchFixtureBrowser } from "./test-browser.mjs";

test("parseTabHeader: só ids de aba válidos; ausente = aba do pai", () => {
	assert.equal(parseTabHeader(undefined), undefined);
	assert.equal(parseTabHeader(""), undefined);
	assert.equal(parseTabHeader("t3"), "t3");
	assert.throws(() => parseTabHeader("../x"), /invalid tab id/);
	assert.throws(() => parseTabHeader("t1; drop"), /invalid tab id/);
});

test("createTabScope: getPage dentro de run() cai na aba pedida; fora, na do pai", async () => {
	const seen = [];
	const session = {
		getPage: async (tabId) => { seen.push(["get", tabId]); return tabId ?? "parent"; },
		peekPage: (tabId) => tabId ?? "parent",
		tabCount: () => 0,
	};
	const scope = createTabScope(session);
	assert.equal(await scope.getPage(), "parent");
	assert.equal(await scope.run("t2", async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
		return scope.getPage();
	}), "t2");
	// Duas requisições concorrentes não se misturam.
	const [a, b] = await Promise.all([
		scope.run("t1", async () => { await new Promise((r) => setTimeout(r, 10)); return scope.getPage(); }),
		scope.run("t2", async () => scope.getPage()),
	]);
	assert.deepEqual([a, b], ["t1", "t2"]);
	assert.equal(scope.run("t5", () => scope.peekPage()), "t5");
});

test("createTabScope: recusa abrir aba acima do teto do servidor", async () => {
	const scope = createTabScope({ tabCount: () => MAX_CHILD_TABS, openTab: async () => "t99" });
	await assert.rejects(scope.openTab("http://x"), /too many open tabs/);
});

test("abas reais: cada aba tem a sua página, o pai segue intacto e fechar uma não mexe nas outras", async (t) => {
	const fixture = await launchFixtureBrowser({
		"/parent": "<html><title>parent</title><body><h1>parent page</h1></body></html>",
		"/a": "<html><title>A</title><body>aaa</body></html>",
		"/b": "<html><title>B</title><body>bbb</body></html>",
	});
	if (!fixture) return t.skip("Chromium indisponível");
	try {
		const seed = await fixture.newPage();
		await seed.goto(`${fixture.base}/parent`);
		const context = seed.context();
		const session = createBrowserSession({
			cdpUrl: "http://127.0.0.1:9222",
			chromium: { connectOverCDP: async () => ({ isConnected: () => true, contexts: () => [context], close: async () => {} }) },
		});
		assert.equal(await session.getPage(), seed);
		const a = await session.openTab(`${fixture.base}/a`);
		const b = await session.openTab(`${fixture.base}/b`);
		assert.notEqual(a, b);
		assert.equal(await (await session.getPage(a)).title(), "A");
		assert.equal(await (await session.getPage(b)).title(), "B");
		// A página do pai não mudou e continua sendo a padrão.
		assert.equal(await session.getPage(), seed);
		assert.equal(await seed.title(), "parent");
		assert.equal(session.tabCount(), 2);
		assert.deepEqual(await session.closeTab(a), { closed: true });
		assert.deepEqual(await session.closeTab(a), { closed: false });
		await assert.rejects(session.getPage(a), /Tab not found/);
		assert.equal(await (await session.getPage(b)).title(), "B");
		assert.equal(session.tabCount(), 1);
		await session.closeTab(b);
		assert.equal(seed.isClosed(), false);
	} finally {
		await fixture.close();
	}
});

test("abas esquecidas (mais de 10 min) são fechadas ao abrir outra; as recentes ficam", async () => {
	let clock = 0;
	const pages = [];
	const mkPage = () => { const p = { closed: false, isClosed: () => p.closed, close: async () => { p.closed = true; }, bringToFront: async () => {}, evaluate: async () => 1 }; pages.push(p); return p; };
	const context = { pages: () => [], newPage: async () => mkPage() };
	const session = createBrowserSession({
		cdpUrl: "http://127.0.0.1:9222", now: () => clock,
		chromium: { connectOverCDP: async () => ({ isConnected: () => true, contexts: () => [context] }) },
	});
	await session.getPage();
	const old = await session.openTab();
	clock = 9 * 60 * 1000;
	const recent = await session.openTab();
	clock = 11 * 60 * 1000;
	const scope = createTabScope(session);
	const { tabId } = await scope.openTab();
	assert.equal(session.peekPage(old), undefined);
	assert.ok(session.peekPage(recent));
	assert.ok(session.peekPage(tabId));
	assert.equal(session.tabCount(), 2);
});
