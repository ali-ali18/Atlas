import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserActions } from "./browser-actions.mjs";

function fakePage({ candidates = [], log = [], fillError } = {}) {
	let href = "https://erp.test/home";
	// Folha do locator: o que a escada de cliques usa (evaluate/locator/click).
	const leaf = (name, onClick) => {
		const node = {
			click: async () => { log.push(`click:${name}`); onClick?.(); },
			focus: async () => {},
			first: () => node,
			locator: () => node,
			evaluate: async (fn) =>
				fn.name === "readPointer"
					? null
					: { visible: true, interactive: true, covered: false, cx: 5, cy: 5, target: { tag: "a" } },
		};
		return node;
	};
	const locator = (kind, arg) => ({
		filter: (f) => locator(`${kind}>filter`, f.hasText),
		evaluateAll: async () => candidates,
		nth: (i) => leaf(`${kind}:${arg}#${i}`),
		first: () => leaf(`${kind}:${arg}`, () => { href = "https://erp.test/next"; }),
	});
	return {
		waitForLoadState: async () => {},
		url: () => href,
		title: async () => "ERP",
		evaluate: async (fn) => {
			if (fn?.name === "readProbeInPage") return { idle: 1000, inflight: 0, busy: false };
			if (fn?.name === "readContentInPage") return { len: 500, landmark: true };
			return 1000;
		},
		locator: (sel) => locator(`locator(${sel})`, sel),
		getByText: (t) => locator("getByText", t),
		fill: async (sel, value) => {
			if (fillError) throw new Error(fillError);
			log.push(`fill:${sel}=${value}`);
		},
		keyboard: { type: async (t) => log.push(`kb:${t}`), press: async (k) => log.push(`press:${k}`) },
		mouse: { click: async () => {} },
	};
}

test("browserClick: text com selector genérico clica no texto, não no primeiro link", async () => {
	const log = [];
	const page = fakePage({
		log,
		candidates: [
			{ text: "Página inicial", visible: true },
			{ text: "Incluir proposta", visible: true },
		],
	});
	const actions = createBrowserActions({ getPage: async () => page });
	const result = await actions.browserClick({ selector: "a", text: "Incluir proposta" });
	assert.equal(result.ok, true);
	assert.deepEqual(log, ["click:locator(a)>filter:Incluir proposta#1"]);
});

test("browserClick: selector genérico sozinho nem toca na página", async () => {
	const log = [];
	const actions = createBrowserActions({ getPage: async () => fakePage({ log }) });
	await assert.rejects(actions.browserClick({ selector: "a" }), /browser_snapshot/);
	assert.deepEqual(log, []);
});

test("browserClick: texto ausente dá erro com dica", async () => {
	const actions = createBrowserActions({ getPage: async () => fakePage({ candidates: [] }) });
	await assert.rejects(actions.browserClick({ text: "Nada" }), /Nenhum elemento visível/);
});

test("browserType: alvo que não é campo vira erro claro; retry em navegação", async () => {
	const actions = createBrowserActions({
		getPage: async () => fakePage({ fillError: "Element is not an <input>, <textarea> or [contenteditable]" }),
	});
	await assert.rejects(actions.browserType({ selector: "#x", text: "a" }), /não é um campo editável/);
	let calls = 0;
	const flaky = createBrowserActions({
		wait: async () => {},
		getPage: async () => {
			calls += 1;
			return fakePage({ fillError: calls === 1 ? "Execution context was destroyed" : undefined });
		},
	});
	const typed = await flaky.browserType({ selector: "#x", text: "a" });
	assert.equal(typed.ok, true);
	assert.equal(typed.settled, true);
	assert.equal(calls, 2);
	await assert.rejects(actions.browserType({ selector: "input", text: "a" }), /genérico/);
});

test("browserClick: devolve url/navegou/settled depois do clique", async () => {
	const actions = createBrowserActions({ getPage: async () => fakePage({}) });
	const result = await actions.browserClick({ selector: "#salvar" });
	assert.equal(result.navigated, true);
	assert.equal(result.url, "https://erp.test/next");
	assert.equal(result.settled, true);
	assert.equal(result.title, "ERP");
});

test("Chrome morto no meio da ação: reinicia uma vez e repete", async () => {
	let restarts = 0;
	let calls = 0;
	const log = [];
	const actions = createBrowserActions({
		restart: async () => { restarts += 1; },
		wait: async () => {},
		getPage: async () => {
			calls += 1;
			if (calls === 1) throw new Error("Target page, context or browser has been closed");
			return fakePage({ log });
		},
	});
	const result = await actions.browserClick({ selector: "#ok" });
	assert.equal(result.ok, true);
	assert.equal(restarts, 1);
});

test("navigate repete em ERR_ABORTED e devolve url final", async () => {
	let attempts = 0;
	const page = {
		...fakePage({}),
		goto: async () => { if (++attempts === 1) throw new Error("net::ERR_ABORTED at https://x"); },
	};
	const actions = createBrowserActions({ getPage: async () => page, wait: async () => {} });
	const result = await actions.navigate("https://x");
	assert.equal(attempts, 2);
	assert.equal(result.url, "https://erp.test/home");
});
