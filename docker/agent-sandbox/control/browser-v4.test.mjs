import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserActions } from "./browser-actions.mjs";
import { createRefActions } from "./browser-refs.mjs";
import { createBrowserV4, BrowserV4Error } from "./browser-v4.mjs";
import { launchFixtureBrowser } from "./test-browser.mjs";

// Vídeo com 1.000 comentários: 40 na página, "Show more comments" traz mais 50 (o nº 870 tem a resposta).
const TOTAL = 1000;
const comment = (n) => (n === 870 ? "@viewer870: Sponsor update, the discount code is ATLAS-4242 and it expires on 30 November." : `@viewer${n}: Nice video, comment number ${n} about the editing and the music.`);
const VIDEO = `<!doctype html><html><head><title>How to edit a video</title></head><body>
<main>
<h1>How to edit a video</h1>
<p>A tutorial about editing videos with free tools.</p>
<section>
<h2>1,000 Comments</h2>
<ul id="comments">${Array.from({ length: 40 }, (_, i) => `<li class="c"><span>${comment(i + 1)}</span> <button type="button">Reply</button></li>`).join("")}</ul>
<button id="more" type="button">Show more comments</button>
</section>
<form action="/post" method="post"><label>Your comment <input name="body" type="text"></label><label>Password <input type="password" name="pw"></label><button id="send" type="submit">Post comment</button></form>
</main>
<footer><a href="/about">About us</a></footer>
<script>
const all = ${JSON.stringify(Array.from({ length: TOTAL }, (_, i) => comment(i + 1)))};
let loaded = 40;
document.getElementById("more").addEventListener("click", () => {
  const ul = document.getElementById("comments");
  for (let i = loaded; i < Math.min(all.length, loaded + 50); i++) { const li = document.createElement("li"); li.className = "c"; li.innerHTML = "<span></span> <button type='button'>Reply</button>"; li.firstChild.textContent = all[i]; ul.appendChild(li); }
  loaded = Math.min(all.length, loaded + 50);
  if (loaded >= all.length) document.getElementById("more").remove();
});
</script></body></html>`;

const fixtures = await launchFixtureBrowser({ "/video": VIDEO });
after(async () => {
	await fixtures?.close();
});
const skip = fixtures ? false : "Chromium/playwright-core indisponível";

async function setup() {
	const page = await fixtures.newPage();
	await page.goto(`${fixtures.base}/video`);
	await page.waitForLoadState("load");
	const actions = createBrowserActions({ getPage: async () => page });
	const refs = createRefActions({ withPageRetry: actions.withPageRetry, clickElement: actions.clickElement });
	actions.setObserver(refs.observeAction);
	const workspaceDir = await mkdtemp(join(tmpdir(), "atlas-v4-"));
	const handle = createBrowserV4({
		withPageRetry: actions.withPageRetry,
		collect: refs.collect,
		noteDomRefs: () => refs.axStore.setDom(page),
		browserAct: refs.browserAct,
		browserWait: refs.browserWait,
		navigate: actions.navigate,
		listTabs: async () => [{ index: 1, url: page.url(), title: await page.title(), active: true }],
		switchTab: async () => {},
		closeTab: async () => {},
		clickElement: actions.clickElement,
		locateRef: refs.locateRef,
		workspaceDir,
		fs: fsp,
	});
	const ok = async (kind, params) => {
		const out = await handle(kind, params);
		assert.equal(out.ok, true, `${kind}: ${out.error}`);
		return out.data;
	};
	return { page, handle, ok, workspaceDir };
}

test("mapa: estrutura e tamanho da lista, sem imprimir a lista", { skip }, async () => {
	const { ok } = await setup();
	const map = await ok("browser.map", {});
	const list = map.sections.find((s) => s.kind === "list" && s.items === 40);
	assert.ok(list, JSON.stringify(map.sections));
	assert.equal(list.declaredTotal, 1000);
	assert.equal(list.canLoadMore, true);
	assert.match(list.label, /1,000 Comments/);
	assert.ok(map.sections.some((s) => s.kind === "form"), "o formulário é uma seção");
	assert.ok(JSON.stringify(map).length < 2500, `mapa com ${JSON.stringify(map).length} caracteres`);
});

test("partes numeradas com refs, dizendo onde estão e quanto falta", { skip }, async () => {
	const { ok } = await setup();
	const map = await ok("browser.map", {});
	const id = map.sections.find((s) => s.items === 40).id;
	const first = await ok("browser.read", { section: id, from: 1, count: 25 });
	assert.equal(first.to, 25);
	assert.equal(first.loaded, 40);
	assert.equal(first.nextFrom, 26);
	assert.match(first.items[0].text, /viewer1:/);
	assert.ok(first.items[0].refs?.some((r) => r.name === "Reply"), "cada comentário traz a ref do Reply");
	const rest = await ok("browser.read", { section: id, from: 26, count: 50 });
	assert.equal(rest.to, 40);
	assert.equal(rest.nextFrom, null);
});

test("1.000 comentários: carregar mais, busca na VM acha o nº 870 com ref, e o arquivo guarda tudo", { skip }, async () => {
	const { ok, workspaceDir } = await setup();
	const map = await ok("browser.map", {});
	const id = map.sections.find((s) => s.items === 40).id;
	const none = await ok("browser.find", { query: "discount code", section: id });
	assert.equal(none.totalMatches, 0);
	assert.equal(none.searchedItems, 40);
	let last;
	for (let i = 0; i < 2; i += 1) last = await ok("browser.load_more", { section: id, times: 10 });
	assert.equal(last.after, 40 + 20 * 50 > 1000 ? 1000 : 40 + 20 * 50);
	assert.equal(last.method, "button");
	const hit = await ok("browser.find", { query: "Discount Code", section: id });
	assert.equal(hit.totalMatches, 1);
	assert.equal(hit.matches[0].n, 870);
	assert.match(hit.matches[0].snippet, /ATLAS-4242/);
	assert.match(hit.matches[0].ref, /^e\d+$/, "a busca devolve ref para agir");
	const exp = await ok("browser.export", { section: id, loadAll: true });
	assert.equal(exp.items, 1000);
	assert.equal(exp.stoppedBy, "end");
	const file = JSON.parse(await readFile(exp.path, "utf8"));
	assert.equal(file.items.length, 1000);
	assert.ok(exp.path.startsWith(workspaceDir));
	const part = await ok("browser.read", { export: exp.exportId, from: 868, count: 5 });
	assert.equal(part.items.find((i) => i.n === 870).text.includes("ATLAS-4242"), true);
	assert.equal(part.loaded, 1000);
});

test("carregar mais no fim diz que acabou (nada novo)", { skip }, async () => {
	const { ok } = await setup();
	const map = await ok("browser.map", {});
	const id = map.sections.find((s) => s.items === 40).id;
	await ok("browser.export", { section: id, loadAll: true });
	const again = await ok("browser.load_more", { section: id, times: 2 });
	assert.equal(again.reachedEnd, true);
	assert.equal(again.after, 1000);
});

test("act: enviar formulário declarado como browse é recusado; senha só o dono; browse livre", { skip }, async () => {
	const { ok, handle, page } = await setup();
	const map = await ok("browser.map", {});
	const form = map.sections.find((s) => s.kind === "form");
	const fields = await ok("browser.read", { section: form.id, from: 1, count: 10 });
	const byText = (re) => fields.items.find((i) => re.test(i.text));
	const pw = byText(/password/i);
	assert.match(pw.text, /hidden: only the owner/);
	const send = byText(/Post comment/);
	const refOf = (item) => item.refs[0].ref;
	const refused = await handle("browser.act", { ref: refOf(send), action: "click", intent: "browse" });
	assert.equal(refused.ok, false);
	assert.equal(refused.code, "SUBMIT_INTENT_REQUIRED");
	const secret = await ok("browser.act", { ref: refOf(pw), action: "type", text: "hunter2", intent: "browse" });
	assert.equal(secret.needsOwner, "password");
	assert.equal(await page.inputValue("input[type=password]"), "", "nada foi digitado na senha");
	const typed = await ok("browser.act", { ref: refOf(byText(/text: Your comment/)), action: "type", text: "hello", intent: "browse" });
	assert.ok(typed.url);
});

test("seção que sumiu da página falha com a dica de mapear de novo", { skip }, async () => {
	const { handle, ok } = await setup();
	await ok("browser.map", {});
	const out = await handle("browser.read", { section: "s99" });
	assert.equal(out.ok, false);
	assert.equal(out.code, "section_missing");
	assert.ok(BrowserV4Error);
});

test("tela: devolve PNG com o tamanho", { skip }, async () => {
	const { ok } = await setup();
	const shot = await ok("browser.screenshot", {});
	assert.equal(shot.mediaType, "image/png");
	assert.ok(shot.width > 100 && shot.height > 100);
	assert.ok(shot.data.length > 100);
});
