/**
 * Ações `browser.*` no worker (F8.1): validação do formato, escopo pelo dono e tradução da resposta do control server.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/browser-actions.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BROWSER_KIND_LIST, BROWSER_KINDS, SUBMIT_INTENT_REQUIRED } from "@workspace/agent";
import { BROWSER_PARAMS, createBrowserActionHandlers, type BrowserControlPost } from "./browser-actions.js";

function rig(answer: unknown = { ok: true, data: { fine: true } }) {
	const calls: Array<Parameters<BrowserControlPost>[0]> = [];
	const post: BrowserControlPost = async (input) => {
		calls.push(input);
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return { calls, handlers: createBrowserActionHandlers({ post }) };
}

test("há um handler e um formato para cada kind do protocolo", () => {
	const { handlers } = rig();
	assert.deepEqual(Object.keys(handlers).sort(), [...BROWSER_KIND_LIST].sort());
	assert.deepEqual(Object.keys(BROWSER_PARAMS).sort(), [...BROWSER_KIND_LIST].sort());
});

test("leva o kind à rota da VM, escopado pelo dono do run, e devolve o dado", async () => {
	const { calls, handlers } = rig({ ok: true, data: { sections: [] } });
	const out = await handlers[BROWSER_KINDS.map]({ userId: "u1", runId: "run-9", params: {} });
	assert.deepEqual(out, { ok: true, data: { sections: [] } });
	assert.deepEqual(calls, [{ userId: "u1", runId: "run-9", path: "/browser/v4", body: { kind: "browser.map", params: {} } }]);
});

test("formato inválido ou campo desconhecido nem chega na VM", async () => {
	const { calls, handlers } = rig();
	for (const [kind, params] of [
		[BROWSER_KINDS.open, { url: "http://169.254.169.254/latest" }],
		[BROWSER_KINDS.open, { url: "file:///etc/passwd" }],
		[BROWSER_KINDS.open, { url: "https://ok.test/", extra: 1 }],
		[BROWSER_KINDS.read, { section: "s1", from: 0 }],
		[BROWSER_KINDS.read, { section: "s1", export: "x1234" }],
		[BROWSER_KINDS.read, {}],
		[BROWSER_KINDS.read, { section: "../../etc" }],
		[BROWSER_KINDS.act, { ref: "e1", action: "click" }],
		[BROWSER_KINDS.act, { ref: "e1", action: "rm -rf", intent: "browse" }],
		[BROWSER_KINDS.export, { section: "s2", path: "/etc/passwd" }],
		[BROWSER_KINDS.tabs, { action: "open", url: "https://x.test" }],
	] as const) {
		const out = await handlers[kind]({ userId: "u1", params });
		assert.equal(out.ok, false, `${kind} ${JSON.stringify(params)}`);
	}
	assert.equal(calls.length, 0);
});

test("o código estruturado da VM chega em data.code (a tool decide por ele, não pelo texto)", async () => {
	const { handlers } = rig({ ok: false, error: "This control submits a form.", code: SUBMIT_INTENT_REQUIRED });
	const out = await handlers[BROWSER_KINDS.act]({ userId: "u1", params: { ref: "e1", action: "click", intent: "browse" } });
	assert.deepEqual(out, { ok: false, error: "This control submits a form.", data: { code: SUBMIT_INTENT_REQUIRED } });
});

test("VM fora do ar vira erro honesto; cancelamento propaga", async () => {
	const down = rig(new Error("connect ECONNREFUSED"));
	const out = await down.handlers[BROWSER_KINDS.map]({ userId: "u1", params: {} });
	assert.equal(out.ok, false);
	assert.match(out.error ?? "", /could not be reached: connect ECONNREFUSED/);
	const abort = new AbortController();
	abort.abort();
	await assert.rejects(down.handlers[BROWSER_KINDS.map]({ userId: "u1", params: {}, signal: abort.signal }));
});

test("resposta sem forma conhecida não vira sucesso", async () => {
	const { handlers } = rig({ weird: true });
	const out = await handlers[BROWSER_KINDS.map]({ userId: "u1", params: {} });
	assert.equal(out.ok, false);
	assert.match(out.error ?? "", /without a reason/);
});

test("dono B não alcança a VM do dono A: o userId do run é o único escopo enviado", async () => {
	const { calls, handlers } = rig();
	await handlers[BROWSER_KINDS.map]({ userId: "A", params: {} });
	await handlers[BROWSER_KINDS.map]({ userId: "B", params: {} });
	assert.deepEqual(calls.map((c) => c.userId), ["A", "B"]);
	assert.ok(calls.every((c) => !JSON.stringify(c.body).includes("userId")), "o body nunca leva userId vindo do modelo");
});
