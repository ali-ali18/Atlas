// Chat do painel do Gemini: container com rolagem própria e muitas mensagens, a última abaixo da dobra.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createBrowserActions } from "./browser-actions.mjs";
import { createRefActions } from "./browser-refs.mjs";
import { createPageReader } from "./reader.mjs";
import { launchFixtureBrowser } from "./test-browser.mjs";

const messages = Array.from({ length: 200 }, (_, i) => `<div class="m"><p>Mensagem ${i + 1} do painel</p></div>`).join("");
const page = `<body style="margin:0"><h1>Video</h1>
<aside style="position:fixed;right:0;top:0;width:300px;height:300px;overflow:auto" id="chat">${messages}<p>RESPOSTA FINAL DO GEMINI</p><button>Copiar resposta</button></aside>
<div style="height:50px;overflow:hidden"><p>Cortado por overflow hidden mas lido</p><p style="margin-top:200px">Abaixo do corte hidden</p></div>
<div aria-hidden="true"><p>Decorativo aria-hidden</p></div>
<p style="display:none">Oculto display none</p></body>`;

const fixtures = await launchFixtureBrowser({ "/chat": page });
after(() => fixtures?.close());
const skip = fixtures ? false : "Chromium/playwright-core indisponível";

async function open(options = {}) {
	const p = await fixtures.newPage();
	await p.goto(`${fixtures.base}/chat`);
	await p.waitForLoadState("load");
	const actions = createBrowserActions({ getPage: async () => p });
	const refs = createRefActions({ withPageRetry: actions.withPageRetry, clickElement: actions.clickElement, ...(options) });
	actions.setObserver(refs.observeAction);
	const reader = createPageReader({ withPageRetry: actions.withPageRetry, registry: refs.registry, collect: refs.collect, locateRef: refs.locateRef, observeAction: refs.observeAction, clickElement: actions.clickElement });
	return { p, refs, reader };
}

test("real: browser_read traz o fim de um container com rolagem própria (abaixo da dobra)", { skip }, async () => {
	const { reader } = await open();
	const res = await reader.readPage({ limit: 20000 });
	assert.match(res.text, /Mensagem 1 do painel/);
	assert.match(res.text, /Mensagem 200 do painel/);
	assert.match(res.text, /RESPOSTA FINAL DO GEMINI/);
	assert.match(res.text, /button "Copiar resposta"/);
	assert.match(res.text, /Abaixo do corte hidden/, "texto cortado por overflow não é oculto");
});

test("real: o filtro de oculto continua valendo (display:none)", { skip }, async () => {
	const { reader } = await open();
	const res = await reader.readPage({ limit: 20000 });
	assert.doesNotMatch(res.text, /Oculto display none/);
});

test("real: a árvore (snapshot) pagina o conteúdo do container com rolagem até o fim", { skip }, async () => {
	const { refs } = await open({ axOn: undefined });
	let tree = "";
	let offset = 0;
	for (let i = 0; i < 30; i += 1) {
		const snap = await refs.browserSnapshot({ area: "page", offset, limit: 3000 });
		tree += `${snap.tree}\n`;
		if (snap.nextOffset == null) break;
		offset = snap.nextOffset;
	}
	assert.match(tree, /RESPOSTA FINAL DO GEMINI/);
});
