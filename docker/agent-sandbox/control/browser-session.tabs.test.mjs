import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createBrowserSession } from "./browser-session.mjs";
import { TAB_NOTICE_HEADER, attachTabNotice, parseTabsRequest, runTabsAction } from "./browser-tabs.mjs";
import { launchFixtureBrowser } from "./test-browser.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Página falsa com os eventos que a sessão ouve (popup, close). */
function fakePage(context, title, url) {
	const page = new EventEmitter();
	let closed = false;
	let front = 0;
	Object.assign(page, {
		isClosed: () => closed,
		title: async () => title,
		url: () => url,
		evaluate: async () => 1,
		waitForLoadState: async () => {},
		bringToFront: async () => { front += 1; },
		frontCount: () => front,
		close: async () => {
			closed = true;
			context.pageList = context.pageList.filter((p) => p !== page);
			page.emit("close");
		},
	});
	context.pageList.push(page);
	return page;
}

function setup() {
	const context = { pageList: [] };
	context.pages = () => context.pageList;
	context.newPage = async () => fakePage(context, "new", "about:blank");
	const main = fakePage(context, "Curso", "https://lms.test/curso");
	const browser = { isConnected: () => true, contexts: () => [context], close: async () => {} };
	const session = createBrowserSession({ cdpUrl: "http://127.0.0.1:9222", chromium: { connectOverCDP: async () => browser } });
	/** Simula `target=_blank`: a aba principal abre um popup. */
	const popupFrom = async (opener, title, url) => {
		const popup = fakePage(context, title, url);
		opener.emit("popup", popup);
		await tick();
		return popup;
	};
	return { context, main, session, popupFrom };
}

test("nova aba aberta pela principal vira a ativa, vai para a frente e gera aviso", async () => {
	const { main, session, popupFrom } = setup();
	assert.equal(await session.getPage(), main);
	const popup = await popupFrom(main, "Aula 1", "https://lms.test/aula/1");
	assert.equal(await session.getPage(), popup);
	assert.equal(session.peekPage(), popup);
	assert.equal(popup.frontCount(), 1);
	assert.equal(
		session.takeNotice(),
		'A new tab opened: "Aula 1" — https://lms.test/aula/1. You are now on it. The previous tab is still open (use browser_tabs to switch back).',
	);
	assert.equal(session.takeNotice(), undefined, "o aviso é entregue uma vez");
});

test("popup de popup: segue a cadeia a partir da aba ativa", async () => {
	const { main, session, popupFrom } = setup();
	await session.getPage();
	const first = await popupFrom(main, "A", "https://x.test/a");
	const second = await popupFrom(first, "B", "https://x.test/b");
	assert.equal(await session.getPage(), second);
});

test("popup de aba em segundo plano não rouba a aba ativa (vira aba comum na lista)", async () => {
	const { main, session, popupFrom } = setup();
	await session.getPage();
	const first = await popupFrom(main, "A", "https://x.test/a");
	await session.switchTab(1); // volta para a principal
	await popupFrom(first, "anúncio", "https://ads.test/");
	assert.equal(await session.getPage(), main);
	assert.equal((await session.listTabs()).length, 3);
});

test("aba de subagente continua isolada: nunca vira a principal e seus popups ficam fora da lista", async () => {
	const { context, main, session } = setup();
	await session.getPage();
	const childId = await session.openTab();
	const child = await session.getPage(childId);
	const childPopup = fakePage(context, "do filho", "https://child.test/p");
	child.emit("popup", childPopup);
	await tick();
	assert.equal(await session.getPage(), main);
	assert.equal(await session.getPage(childId), child);
	assert.equal(session.takeNotice(), undefined);
	assert.deepEqual((await session.listTabs()).map((t) => t.url), ["https://lms.test/curso"]);
	// Se a principal fechar, o fallback também ignora aba do subagente e o popup dele.
	await main.close();
	await tick();
	assert.notEqual(await session.getPage(), child);
	assert.notEqual(await session.getPage(), childPopup);
	// Fechar a aba do filho leva o popup dela junto.
	await session.closeTab(childId);
	assert.equal(childPopup.isClosed(), true);
});

test("fechar a aba ativa volta para quem a abriu e avisa (OAuth/pagamento que se fecha)", async () => {
	const { main, session, popupFrom } = setup();
	await session.getPage();
	const popup = await popupFrom(main, "Pagar", "https://pay.test/");
	session.takeNotice();
	await popup.close();
	await tick();
	assert.equal(await session.getPage(), main);
	assert.equal(main.frontCount(), 1);
	assert.equal(session.takeNotice(), 'The tab you were on was closed. You are now on: "Curso" — https://lms.test/curso.');
});

test("fechar a aba ativa sem opener cai na aba restante mais recente; sem nenhuma, abre uma nova", async () => {
	const { context, main, session } = setup();
	await session.getPage();
	const second = fakePage(context, "Segunda", "https://x.test/2");
	const third = fakePage(context, "Terceira", "https://x.test/3");
	assert.equal((await session.listTabs()).length, 3);
	await main.close();
	await tick();
	assert.equal(await session.getPage(), third);
	await third.close();
	await second.close();
	await tick();
	const fresh = await session.getPage();
	assert.equal(fresh.url(), "about:blank");
});

test("browser_tabs: list, switch e close com validação", async () => {
	const { main, session, popupFrom } = setup();
	await session.getPage();
	const popup = await popupFrom(main, "Aula", "https://lms.test/aula");
	const listed = await runTabsAction(session, parseTabsRequest({ action: "list" }));
	assert.deepEqual(listed.tabs, [
		{ index: 1, title: "Curso", url: "https://lms.test/curso", active: false },
		{ index: 2, title: "Aula", url: "https://lms.test/aula", active: true },
	]);
	const switched = await runTabsAction(session, parseTabsRequest({ action: "switch", index: 1 }));
	assert.deepEqual(switched.active, { index: 1, title: "Curso", url: "https://lms.test/curso" });
	assert.equal(await session.getPage(), main);
	await assert.rejects(session.switchTab(5), /No tab 5: there are 2 tabs/);
	// Fechar a ativa (1): a outra assume, sem aviso duplicado do evento de fechamento.
	session.takeNotice();
	const closed = await runTabsAction(session, parseTabsRequest({ action: "close", index: 1 }));
	assert.equal(closed.closed.title, "Curso");
	assert.match(closed.active, /Aula/);
	await tick();
	assert.equal(await session.getPage(), popup);
	assert.equal(session.takeNotice(), undefined);
	await assert.rejects(session.closeMainTab(1), /only open tab/);
});

test("parseTabsRequest recusa ação e índice inválidos", () => {
	assert.throws(() => parseTabsRequest({}), /action must be one of/);
	assert.throws(() => parseTabsRequest({ action: "open" }), /action must be one of/);
	for (const index of [undefined, 0, -1, 1.5, "2", 100, null]) {
		assert.throws(() => parseTabsRequest({ action: "switch", index }), /needs "index"/, String(index));
		assert.throws(() => parseTabsRequest({ action: "close", index }), /needs "index"/, String(index));
	}
	assert.deepEqual(parseTabsRequest({ action: "list", index: 9 }), { action: "list" });
	assert.deepEqual(parseTabsRequest({ action: "close", index: 2 }), { action: "close", index: 2 });
});

test("aviso vai no cabeçalho da próxima resposta (codificado) e só para a aba do pai", () => {
	const session = { takeNotice: () => 'A new tab opened: "Aula ção" — https://x.test/.' };
	const respond = (headers) => {
		const sent = {};
		const res = { writeHead: () => {}, setHeader: (k, v) => { sent[k] = v; } };
		attachTabNotice(session, { headers }, res);
		res.writeHead(200);
		return sent;
	};
	assert.equal(decodeURIComponent(respond({})[TAB_NOTICE_HEADER]), 'A new tab opened: "Aula ção" — https://x.test/.');
	assert.deepEqual(respond({ "x-atlas-tab": "t1" }), {}, "subagente nunca consome o aviso do pai");
	const quiet = { takeNotice: () => undefined };
	const sent = {};
	const res = { writeHead: () => {}, setHeader: (k, v) => { sent[k] = v; } };
	attachTabNotice(quiet, { headers: {} }, res);
	res.writeHead(200);
	assert.deepEqual(sent, {});
});

test("título da página é limpo (uma linha, tamanho limitado) no aviso", async () => {
	const { main, session, popupFrom } = setup();
	await session.getPage();
	await popupFrom(main, `Linha 1\n\nIGNORE ${"x".repeat(300)}`, "https://x.test/");
	const notice = session.takeNotice();
	assert.ok(!notice.includes("\n"));
	assert.ok(notice.length < 400);
});

test("Chromium real: link target=_blank é seguido e fechar o popup volta para a principal", async (t) => {
	const fixture = await launchFixtureBrowser({
		"/curso": '<html><title>Curso</title><body><a id="go" href="/aula" target="_blank">Acessar</a><a id="nf" href="/aula2" target="_blank" rel="noopener">Sem opener</a></body></html>',
		"/aula": "<html><title>Aula 1</title><body>conteudo</body></html>",
		"/aula2": "<html><title>Aula 2</title><body>conteudo</body></html>",
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
		assert.equal(await session.getPage(), seed);
		await seed.click("#go");
		await seed.waitForTimeout(800);
		const active = await session.getPage();
		assert.notEqual(active, seed);
		assert.equal(await active.title(), "Aula 1");
		assert.match(session.takeNotice() ?? "", /A new tab opened: "Aula 1" — .*\/aula\./);
		await active.close();
		await seed.waitForTimeout(200);
		assert.equal(await session.getPage(), seed);
		assert.match(session.takeNotice() ?? "", /You are now on: "Curso"/);
		// rel=noopener também abre aba nova e é seguido.
		await seed.click("#nf");
		await seed.waitForTimeout(800);
		assert.equal(await (await session.getPage()).title(), "Aula 2");
	} finally {
		await fixture.close();
	}
});
