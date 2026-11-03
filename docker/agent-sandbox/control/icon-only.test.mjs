// Botão só-ícone (YouTube em janela estreita): o nome mora no aria-label/title/alt, não no texto visível.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createBrowserActions } from "./browser-actions.mjs";
import { createRefActions } from "./browser-refs.mjs";
import { createPageReader } from "./reader.mjs";
import { launchFixtureBrowser } from "./test-browser.mjs";

const svg = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 0l2 6h6l-5 4 2 6-5-4-5 4 2-6-5-4h6z"/></svg>';
const page = `<body style="margin:10px">
<h1>Video</h1>
<div style="display:flex;gap:8px">
<button id="share">Compartilhar</button>
<button id="ask" aria-label="Perguntar" title="Perguntar ao Gemini" onclick="document.title='asked'"><span style="display:none">Texto escondido</span>${svg}</button>
<button id="alt" onclick="document.title='alt'"><img alt="Salvar na lista" width="16" height="16" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></button>
<button id="lby" aria-labelledby="lbl" onclick="document.title='lby'">${svg}</button><span id="lbl" hidden>Curtir vídeo</span>
<button id="ttl" title="Mais ações" onclick="document.title='ttl'">${svg}</button>
<button id="svgt" onclick="document.title='svgt'"><svg width="16" height="16"><title>Cortar clipe</title><rect width="16" height="16"/></svg></button>
</div></body>`;

const pageDelete = `<body style="margin:10px"><button aria-label="Excluir conta" onclick="document.title='conta'">${svg}</button>
<button aria-label="Excluir tudo" onclick="document.title='tudo'">${svg}</button></body>`;
const pageTwoAsk = `<body style="margin:10px"><button aria-label="Perguntar" onclick="document.title='um'">${svg}</button>
<button aria-label="Perguntar" onclick="document.title='dois'">${svg}</button></body>`;
// Um "Enviar" desabilitado, um escondido de leitores e um fora da página: sobra o utilizável.
const pageUsable = `<body style="margin:10px"><button aria-label="Enviar" disabled>${svg}</button>
<div aria-hidden="true"><button aria-label="Enviar" onclick="document.title='hidden'">${svg}</button></div>
<button aria-label="Enviar" style="position:absolute;left:-5000px" onclick="document.title='off'">${svg}</button>
<button aria-label="Enviar" onclick="document.title='ok'">${svg}</button></body>`;
// Card clicável que contém um botão "Excluir": o card não herda o nome do botão de dentro.
const pageCard = `<body style="margin:10px"><div id="card" role="button" tabindex="0" onclick="document.title='card'" style="padding:8px;border:1px solid #888">
<span>${svg}</span><button aria-label="Excluir" onclick="event.stopPropagation();document.title='btn'">${svg}</button></div></body>`;

const fixtures = await launchFixtureBrowser({ "/yt": page, "/del": pageDelete, "/ask2": pageTwoAsk, "/usable": pageUsable, "/card": pageCard });
after(() => fixtures?.close());
const skip = fixtures ? false : "Chromium/playwright-core indisponível";

async function open(path = "/yt") {
	const p = await fixtures.newPage();
	await p.goto(`${fixtures.base}${path}`);
	await p.waitForLoadState("load");
	const actions = createBrowserActions({ getPage: async () => p });
	const refs = createRefActions({ withPageRetry: actions.withPageRetry, clickElement: actions.clickElement, axOn: () => false });
	actions.setObserver(refs.observeAction);
	const reader = createPageReader({
		withPageRetry: actions.withPageRetry,
		registry: refs.registry,
		collect: refs.collect,
		locateRef: refs.locateRef,
		observeAction: refs.observeAction,
		clickElement: actions.clickElement,
	});
	return { p, actions, refs, reader };
}

const NAMES = ["Perguntar", "Salvar na lista", "Curtir vídeo", "Mais ações", "Cortar clipe"];

test("real: browser_read lista controles só-ícone pelo nome acessível", { skip }, async () => {
	const { reader } = await open();
	const res = await reader.readPage({});
	for (const name of NAMES) assert.match(res.text, new RegExp(`\\[e\\d+\\] button "${name}`), `${name} em:\n${res.text}`);
});

test("real: browser_find acha o botão só-ícone pelo nome", { skip }, async () => {
	const { reader } = await open();
	for (const name of NAMES) {
		const res = await reader.findText({ query: name });
		assert.ok(res.total >= 1, `${name}: ${JSON.stringify(res)}`);
		assert.match(res.matches[0].text ?? JSON.stringify(res.matches[0]), new RegExp(name));
	}
});

test("real: clique por texto casa o nome acessível (aria-label, alt, labelledby, title, svg title)", { skip }, async () => {
	const expected = { Perguntar: "asked", "Salvar na lista": "alt", "Curtir vídeo": "lby", "Mais ações": "ttl", "Cortar clipe": "svgt" };
	for (const [name, title] of Object.entries(expected)) {
		const { p, actions } = await open();
		await actions.browserClick({ text: name });
		assert.equal(await p.title(), title, name);
	}
});

test("real: texto visível continua tendo prioridade sobre o nome acessível", { skip }, async () => {
	const { p, actions } = await open();
	await p.evaluate(() => { document.getElementById("share").addEventListener("click", () => { document.title = "shared"; }); });
	await actions.browserClick({ text: "Compartilhar" });
	assert.equal(await p.title(), "shared");
});

test("real: browser_snapshot (árvore AX) lista o botão só-ícone pelo nome", { skip }, async () => {
	const p = await fixtures.newPage();
	await p.goto(`${fixtures.base}/yt`);
	await p.waitForLoadState("load");
	const actions = createBrowserActions({ getPage: async () => p });
	const refs = createRefActions({ withPageRetry: actions.withPageRetry, clickElement: actions.clickElement });
	actions.setObserver(refs.observeAction);
	const snap = await refs.browserSnapshot({});
	assert.equal(snap.engine, "ax");
	for (const name of NAMES) assert.match(snap.tree, new RegExp(`button "${name}`), snap.tree);
});

test("real: nome acessível é exato: \"Excluir\" não clica \"Excluir conta\" e lista os parecidos", { skip }, async () => {
	const { p, actions } = await open("/del");
	await assert.rejects(actions.browserClick({ text: "Excluir" }), /Nomes parecidos: "Excluir conta", "Excluir tudo"/);
	assert.equal(await p.title(), "");
	await actions.browserClick({ text: "excluir  CONTA" });
	assert.equal(await p.title(), "conta");
});

test("real: dois controles com o mesmo nome acessível viram ambíguo, sem clicar", { skip }, async () => {
	const { p, actions } = await open("/ask2");
	await assert.rejects(actions.browserClick({ text: "Perguntar" }), /Mais de um controle se chama "Perguntar"/);
	assert.equal(await p.title(), "");
});

test("real: nome acessível ignora desabilitado, aria-hidden e fora da página", { skip }, async () => {
	const { p, actions } = await open("/usable");
	await actions.browserClick({ text: "Enviar" });
	assert.equal(await p.title(), "ok");
});

test("real: card clicável não herda o nome do botão \"Excluir\" de dentro", { skip }, async () => {
	const { p, actions, reader } = await open("/card");
	const res = await reader.readPage({});
	// Antes, o card (role=button) herdava o aria-label do botão de dentro e aparecia como "Excluir".
	assert.doesNotMatch(res.text, /"Excluir"/, res.text);
	await actions.browserClick({ text: "Excluir" });
	assert.equal(await p.title(), "btn");
});
