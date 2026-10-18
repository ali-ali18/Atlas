import { test } from "node:test";
import assert from "node:assert/strict";
import {
	countCollapsed,
	detectCollection,
	findEntries,
	flattenFrames,
	isExpandable,
	renderEntries,
} from "./outline.mjs";
import { paginateText } from "./text-page.mjs";

const raw = (over) => ({ ref: "e1", tag: "button", type: "", roleAttr: "", ariaLabel: "", labelledBy: "", label: "", text: "", placeholder: "", title: "", alt: "", nameAttr: "", inViewport: true, ...over });

const mainFrame = {
	prefix: "",
	label: "",
	main: true,
	items: [
		{ t: "h", level: 1, text: "Course" },
		{ t: "p", text: "Welcome text" },
		{ t: "h", level: 3, text: "Week 1", ref: "e1" },
		{ t: "frame", mark: "f1" },
		{ t: "i", ref: "e2" },
		{ t: "p", text: "item one", li: true },
		{ t: "lm", name: "nav" },
	],
};
const player = { prefix: "f1", label: "player", crossOrigin: "cdn.test", items: [{ t: "p", text: "Video transcript: the answer is 42" }, { t: "i", ref: "f1e3" }] };
const rawByRef = new Map([
	["e1", raw({ ref: "e1", text: "Week 1", expanded: false })],
	["e2", raw({ ref: "e2", tag: "a", href: "/u1", text: "Unit 1" })],
	["f1e3", raw({ ref: "f1e3", text: "Play" })],
]);

test("flattenFrames: o conteúdo do iframe entra no ponto do iframe, em ordem de leitura", () => {
	const entries = flattenFrames([mainFrame, player], rawByRef);
	const kinds = entries.map((e) => e.kind);
	assert.deepEqual(kinds, ["h", "p", "h", "frame-open", "p", "i", "frame-close", "i", "p", "lm"]);
});

test("flattenFrames: iframe sem marca vai no fim, rotulado", () => {
	const entries = flattenFrames([{ ...mainFrame, items: [{ t: "p", text: "a" }] }, player], rawByRef);
	assert.deepEqual(entries.map((e) => e.kind), ["p", "frame-open", "p", "i", "frame-close"]);
});

test("renderEntries outline: títulos com #, refs, estado, links e frames marcados como não confiáveis", () => {
	const text = renderEntries(flattenFrames([mainFrame, player], rawByRef));
	assert.equal(
		text,
		[
			"# Course",
			"Welcome text",
			"### [e1] Week 1 (collapsed)",
			'[frame f1 "player" other-origin cdn.test, untrusted]',
			"Video transcript: the answer is 42",
			'[f1e3] button "Play"',
			"[/frame f1]",
			'[e2] link "Unit 1" → /u1',
			"- item one",
			"[nav]",
		].join("\n"),
	);
});

test("renderEntries text: só leitura, sem refs, estado, hrefs nem landmarks", () => {
	const text = renderEntries(flattenFrames([mainFrame, player], rawByRef), { view: "text" });
	assert.ok(!/\[e\d|collapsed|→|\[nav\]/.test(text), text);
	assert.match(text, /### Week 1/);
	assert.match(text, /Video transcript/);
});

test("countCollapsed e detectCollection: 3+ itens que só diferem no número viram coleção", () => {
	const heads = [1, 2, 3, 4].map((n) => ({ t: "h", level: 3, text: `Week ${n}`, ref: `e${n}` }));
	const map = new Map(heads.map((h) => [h.ref, raw({ ref: h.ref, text: h.text, expanded: false })]));
	const entries = flattenFrames([{ prefix: "", main: true, items: heads }], map);
	assert.equal(countCollapsed(entries), 4);
	assert.deepEqual(detectCollection(entries), { stem: "week #", count: 4 });
	assert.equal(detectCollection(entries.slice(0, 2)), null);
});

test("findEntries: contexto, seção, ref do próprio elemento ou do interativo vizinho, frame", () => {
	const entries = flattenFrames([mainFrame, player], rawByRef);
	const a = findEntries(entries, { query: "unit 1" });
	assert.equal(a.total, 1);
	assert.deepEqual(a.matches[0], { text: "Unit 1", ref: "e2", role: "link", section: "Week 1", sectionRef: "e1" });
	const b = findEntries(entries, { query: "answer is" });
	assert.equal(b.matches[0].frame, "f1");
	assert.equal(b.matches[0].crossOrigin, "cdn.test");
	assert.equal(b.matches[0].near, "f1e3");
	assert.match(b.matches[0].text, /answer is 42/);
});

test("findEntries: regex, teto de resultados, validação", () => {
	const items = Array.from({ length: 30 }, (_, i) => ({ t: "p", text: `Quiz ${i} due` }));
	const entries = flattenFrames([{ prefix: "", main: true, items }], new Map());
	const found = findEntries(entries, { query: "quiz \\d+ due", regex: true, max: 5 });
	assert.equal(found.matches.length, 5);
	assert.equal(found.total, 30);
	assert.throws(() => findEntries(entries, { query: "" }), /vazia/);
	assert.throws(() => findEntries(entries, { query: "(", regex: true }), /regex inválida/);
	assert.throws(() => findEntries(entries, { query: "x".repeat(300) }), /longa demais/);
});

test("findEntries: trecho longo vem com reticências nos dois lados", () => {
	const text = `${"a ".repeat(80)}NEEDLE${" b".repeat(80)}`;
	const found = findEntries(flattenFrames([{ prefix: "", main: true, items: [{ t: "p", text }] }], new Map()), { query: "needle" });
	assert.ok(found.matches[0].text.startsWith("…") && found.matches[0].text.endsWith("…"));
	assert.ok(found.matches[0].text.length < 200);
});

test("isExpandable: aria-expanded=false, summary e aba; nunca envio, menu, navegação ou escrita", () => {
	const week = raw({ text: "Week 1", expanded: false });
	assert.equal(isExpandable(week), true);
	assert.equal(isExpandable(raw({ tag: "summary", text: "More", expanded: false })), true);
	assert.equal(isExpandable(raw({ roleAttr: "tab", text: "Tab 2", selected: "false" })), true);
	assert.equal(isExpandable(raw({ text: "Week 1", expanded: true })), false, "já aberto");
	assert.equal(isExpandable(raw({ text: "Plain button" })), false, "sem estado de expandir");
	assert.equal(isExpandable({ ...week, type: "submit" }), false);
	assert.equal(isExpandable({ ...week, popup: "menu" }), false);
	assert.equal(isExpandable({ ...week, inMenu: true }), false);
	assert.equal(isExpandable({ ...week, disabled: true }), false);
	assert.equal(isExpandable({ ...week, tag: "a", href: "/other-page" }), false);
	assert.equal(isExpandable({ ...week, tag: "a", href: "#collapse1" }), true);
	for (const name of ["Submit assignment", "Mark as done", "Enviar tarefa", "Concluir módulo", "Delete", "Sign out", "Pagar agora"]) {
		assert.equal(isExpandable({ ...week, text: name }), false, name);
	}
});

test("isExpandable: sinal estrutural de escrita vence o nome (qualquer idioma)", () => {
	const week = raw({ text: "Week 1", expanded: false });
	// <button> sem type dentro de <form> envia: nome neutro ou em outro idioma não o libera.
	for (const text of ["Next", "Weiter", "Absenden", "次へ", "Ok"]) {
		assert.equal(isExpandable({ ...week, text, submits: true }), false, `submits: ${text}`);
		assert.equal(isExpandable({ ...week, text, inWriteForm: true }), false, `inWriteForm: ${text}`);
	}
	// Disclosure legítimo dentro de um form que escreve: aponta um painel, é summary ou aba.
	assert.equal(isExpandable({ ...week, inWriteForm: true, controls: true }), true);
	assert.equal(isExpandable({ ...week, tag: "summary", inWriteForm: true }), true);
	assert.equal(isExpandable({ ...week, roleAttr: "tab", selected: "false", expanded: undefined, inWriteForm: true }), true);
	// Form que só filtra (GET, sem action) não bloqueia.
	assert.equal(isExpandable({ ...week, inWriteForm: false, submits: false }), true);
	// A lista de nomes segue valendo como segunda trava, mesmo sem sinal estrutural.
	assert.equal(isExpandable({ ...week, text: "Salvar" }), false);
});

test("paginateText por linha: páginas consecutivas cobrem o texto e não partem linha", () => {
	const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(40)}`);
	const text = lines.join("\n");
	const limits = { defaultLimit: 1000, maxLimit: 1000, breakOnLine: true };
	let offset = 0;
	let rebuilt = "";
	let guard = 0;
	for (;;) {
		const page = paginateText(text, { offset }, limits);
		assert.ok(page.text.length <= 1000);
		if (page.truncated) assert.ok(page.text.endsWith("\n"), "corta no fim de linha");
		rebuilt += page.text;
		if (page.nextOffset === null || ++guard > 50) break;
		offset = page.nextOffset;
	}
	assert.equal(rebuilt, text);
});
