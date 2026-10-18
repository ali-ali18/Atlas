import { test } from "node:test";
import assert from "node:assert/strict";
import { createRefActions, parseActArgs, parseWaitArgs } from "./browser-refs.mjs";

const base = { tag: "input", type: "text", roleAttr: "", ariaLabel: "", labelledBy: "", label: "", text: "", placeholder: "", title: "", alt: "", nameAttr: "", inViewport: true };

const digest = (state, over = {}) => ({
	doc: "d1", url: state.href, title: "Orçamentos", blocks: [], states: [], dialogs: [], refs: [], errors: [], ...over,
});

// Página falsa: `dom` é a lista de elementos "no DOM"; o evaluate do collect
// atribui refs como o script real faria.
function fakePage(dom, { log = [], href = "https://erp.test/orcamentos.php#add" } = {}) {
	const state = { dom, href };
	const frame = {
		url: () => state.href,
		name: () => "",
		evaluate: async (fn, opts) => {
			if (opts && "maxScan" in opts) {
				if (opts.mode === "full") for (const el of state.dom) delete el.ref;
				let seq = opts.start;
				const raw = [];
				for (const el of state.dom) {
					if (opts.mode === "incremental" && el.ref) continue;
					if (el.hidden) continue;
					el.ref = `e${++seq}`;
					raw.push({ ...base, ...el.raw, ref: el.ref });
				}
				return { raw, seq };
			}
			return {};
		},
		locator: (selector) => {
			const ref = /"(e\d+)"/.exec(selector)?.[1];
			const el = state.dom.find((candidate) => candidate.ref === ref);
			const loc = {
				count: async () => (el ? 1 : 0),
				first: () => loc,
				scrollIntoViewIfNeeded: async () => {},
				isVisible: async () => Boolean(el) && !el.hidden,
				isEnabled: async () => !el?.disabled,
				click: async () => {
					log.push(`click:${ref}`);
					if (el.navigatesTo) state.href = el.navigatesTo;
				},
				fill: async (value) => {
					if (el.notField) throw new Error("Element is not an <input>, <textarea> or [contenteditable]");
					log.push(`fill:${ref}=${value}`);
					el.value = value;
					if (el.revealsOnType) state.dom.push({ raw: { ...base, tag: "li", roleAttr: "option", text: el.revealsOnType } });
				},
				press: async (key) => log.push(`press:${ref}:${key}`),
				selectOption: async (opt) => {
					if (!el.options?.includes(opt.label ?? opt.value)) throw new Error("did not find some options");
					log.push(`select:${ref}=${opt.label ?? opt.value}`);
					el.value = opt.label ?? opt.value;
				},
				setChecked: async (v) => log.push(`check:${ref}=${v}`),
				hover: async () => log.push(`hover:${ref}`),
				evaluate: async () => ({ value: el.value ?? "", checked: undefined }),
			};
			return loc;
		},
	};
	return {
		state,
		mainFrame: () => frame,
		frames: () => [frame],
		url: () => state.href,
		title: async () => "Orçamentos",
		evaluate: async (fn) => {
			if (fn?.name === "readDigestInPage") {
				if (state.digestQueue?.length) return state.digestQueue.shift();
				return digest(state, { errors: state.errors ?? [] });
			}
			if (fn?.name === "readProbeInPage") return { idle: 1000, inflight: 0, busy: false };
			if (fn?.name === "installProbeInPage") return undefined;
			return { scrollY: 0, scrollHeight: 900, viewportHeight: 720 };
		},
		waitForFunction: async () => {},
		waitForURL: async () => {},
		waitForLoadState: async () => {},
	};
}

function setup(dom, opts) {
	const page = fakePage(dom, opts);
	const actions = createRefActions({
		withPageRetry: async (fn) => fn(page),
		stabilize: async (p, o = {}) => ({ url: p.url(), title: "Orçamentos", navigated: o.urlBefore !== undefined && o.urlBefore !== p.url(), settled: true }),
		sleep: async () => {},
	});
	return { page, actions };
}

const proposalDom = () => [
	{ raw: { label: "Cliente", autocomplete: true, value: "" }, revealsOnType: "Alisson Camargo" },
	{ raw: { tag: "select", label: "Vendedor", value: "", options: [{ label: "Alisson" }, { label: "Bruno" }] }, options: ["Alisson", "Bruno"] },
	{ raw: { tag: "button", text: "Adicionar item" } },
	{ raw: { tag: "a", text: "Página inicial", href: "/home" }, navigatesTo: "https://erp.test/home" },
	{ raw: { tag: "button", text: "Oculto" }, hidden: true },
	{ raw: { tag: "input", type: "password", label: "Senha", secret: true, value: "x" }, notField: true },
];

test("parseActArgs: valida ref, ação e tamanhos", () => {
	assert.deepEqual(parseActArgs({ ref: "e3", action: "click" }).action, "click");
	assert.throws(() => parseActArgs({ ref: "a", action: "click" }), /ref inválido/);
	assert.throws(() => parseActArgs({ ref: "e1", action: "drag" }), /action inválida/);
	assert.throws(() => parseActArgs({ ref: "e1", action: "type" }), /exige `value`/);
	assert.throws(() => parseActArgs({ ref: "e1", action: "type", value: "x".repeat(20001) }), /muito longo/);
	assert.throws(() => parseActArgs({ ref: "e1", action: "press" }), /exige/);
});

test("parseWaitArgs: tipos, timeout limitado", () => {
	assert.equal(parseWaitArgs({ for: "stable" }).timeoutMs, 8000);
	assert.equal(parseWaitArgs({ for: "text", value: "ok", timeoutMs: 99999 }).timeoutMs, 20000);
	assert.throws(() => parseWaitArgs({ for: "text" }), /exige/);
	assert.throws(() => parseWaitArgs({ for: "ref", value: "abc" }), /ref/);
	assert.throws(() => parseWaitArgs({ for: "nada" }), /inválido/);
});

test("browserSnapshot: lista visíveis com refs, esconde ocultos e não vaza senha", async () => {
	const { actions } = setup(proposalDom());
	const snap = await actions.browserSnapshot({});
	assert.equal(snap.total, 5);
	assert.equal(snap.elements[0].ref, "e1");
	assert.match(snap.lines[0], /combobox "Cliente" autocomplete/);
	assert.match(snap.lines[1], /options=\[Alisson\|Bruno\]/);
	assert.ok(snap.lines.every((line) => !line.includes("Oculto")));
	assert.match(snap.lines[4], /nunca preencha/);
	assert.equal(snap.scrollHeight, 900);
});

test("browserAct: preenche por ref, delta traz o autocomplete; não clica no 1º link", async () => {
	const log = [];
	const { actions } = setup(proposalDom(), { log });
	await actions.browserSnapshot({});
	const typed = await actions.browserAct({ ref: "e1", action: "type", value: "Alisson" });
	assert.equal(typed.ok, true);
	assert.equal(typed.field.value, "Alisson");
	assert.equal(typed.newTotal, 1);
	assert.match(typed.newElements[0], /option "Alisson Camargo"/);
	// o ref novo não renumera os antigos
	assert.match(typed.newElements[0], /\[e6\]/);
	const selected = await actions.browserAct({ ref: "e2", action: "select", value: "Alisson" });
	assert.equal(selected.field.value, "Alisson");
	assert.deepEqual(log, ["fill:e1=Alisson", "select:e2=Alisson"]);
	await assert.rejects(actions.browserAct({ ref: "e2", action: "select", value: "Zé" }), /não existe nesse select/);
});

test("browserAct: só erros de validação NOVOS depois da ação voltam em `errors`", async () => {
	const { actions, page } = setup(proposalDom());
	await actions.browserSnapshot({});
	// Banner de acessibilidade (role=alert) já estava na página: não é culpa da ação.
	const banner = "Site accessibility: press Tab to navigate";
	page.state.digestQueue = [digest(page.state, { errors: [banner] }), digest(page.state, { errors: [banner, "Cliente: Campo obrigatório"] })];
	const bad = await actions.browserAct({ ref: "e1", action: "type", value: "x" });
	assert.deepEqual(bad.errors, ["Cliente: Campo obrigatório"]);
	page.state.digestQueue = [digest(page.state, { errors: [banner] }), digest(page.state, { errors: [banner] })];
	const none = await actions.browserAct({ ref: "e1", action: "type", value: "y" });
	assert.equal("errors" in none, false);
});

test("browserAct: clique que navega avisa e não manda delta", async () => {
	const { actions } = setup(proposalDom());
	await actions.browserSnapshot({});
	const res = await actions.browserAct({ ref: "e4", action: "click" });
	assert.equal(res.navigated, true);
	assert.equal(res.newTotal, 0);
});

test("browserAct: ref velho, oculto, desabilitado e alvo que não é campo", async () => {
	const dom = proposalDom();
	dom[2].disabled = true;
	const { actions } = setup(dom);
	await assert.rejects(actions.browserAct({ ref: "e1", action: "click" }), /não encontrado.*browser_snapshot/);
	await actions.browserSnapshot({});
	await assert.rejects(actions.browserAct({ ref: "e99", action: "click" }), /não encontrado/);
	await assert.rejects(actions.browserAct({ ref: "e3", action: "click" }), /desabilitado/);
	await assert.rejects(actions.browserAct({ ref: "e5", action: "type", value: "x" }), /não é um campo editável/);
});

test("ref de snapshot antigo some depois de novo snapshot completo", async () => {
	const dom = proposalDom();
	const { actions, page } = setup(dom);
	await actions.browserSnapshot({});
	page.state.dom.splice(0, 1); // elemento sumiu (re-render)
	await actions.browserSnapshot({});
	await assert.rejects(actions.browserAct({ ref: "e5", action: "click" }), /não encontrado/);
});

test("browserWait: ok, timeout honesto e ref", async () => {
	const { actions, page } = setup(proposalDom());
	await actions.browserSnapshot({});
	assert.equal((await actions.browserWait({ for: "text", value: "Orçamento salvo" })).met, true);
	assert.equal((await actions.browserWait({ for: "stable" })).met, true);
	assert.equal((await actions.browserWait({ for: "ref", value: "e1", timeoutMs: 50 })).met, true);
	const missing = await actions.browserWait({ for: "ref", value: "e77", timeoutMs: 1 });
	assert.equal(missing.met, false);
	assert.match(missing.reason, /não ocorreu/);
	page.waitForFunction = async () => {
		throw new Error("Timeout 100ms exceeded.\n  at ...");
	};
	const timeout = await actions.browserWait({ for: "text", value: "nunca", timeoutMs: 100 });
	assert.equal(timeout.met, false);
	assert.match(timeout.reason, /Timeout 100ms/);
});
