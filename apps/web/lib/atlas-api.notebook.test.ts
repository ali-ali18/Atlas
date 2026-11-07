import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	apiErrorCode,
	AtlasApiError,
	createNote,
	deleteBotRule,
	deleteNote,
	dismissSleepProposal,
	listBotRules,
	listNotes,
	listSleepChanges,
	listSleepReports,
	patchBotRule,
	undoMemoryChange,
	updateNote,
} from "./atlas-api";

type Call = { url: string; method: string; body: unknown };
const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Troca o `fetch` por um dublê que registra a chamada e devolve o JSON pedido. */
function fakeFetch(status: number, json: unknown): Call[] {
	const calls: Call[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
		return new Response(status === 204 ? null : JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
	return calls;
}

test("notas: lista com e sem bot, cria, edita (fixar) e apaga pelas rotas certas", async () => {
	const note = { id: "n1", title: "t" };
	let calls = fakeFetch(200, { notes: [note], limit: 500 });
	assert.deepEqual((await listNotes({ botId: "b 1" })).notes, [note]);
	await listNotes();
	assert.deepEqual(calls.map((call) => call.url), ["/v1/notes?botId=b%201", "/v1/notes"]);

	calls = fakeFetch(201, { note });
	assert.deepEqual(await createNote({ title: "t", body: "b", botId: null }), note);
	assert.deepEqual(calls[0], { url: "/v1/notes", method: "POST", body: { title: "t", body: "b", botId: null } });

	calls = fakeFetch(200, { note });
	await updateNote("n/1", { pinned: true });
	assert.deepEqual(calls[0], { url: "/v1/notes/n%2F1", method: "PATCH", body: { pinned: true } });

	calls = fakeFetch(200, { ok: true });
	await deleteNote("n1");
	assert.deepEqual(calls[0], { url: "/v1/notes/n1", method: "DELETE", body: undefined });
});

test("regras: lista, muda (veredito e observação) e apaga escopadas pelo bot", async () => {
	const rule = { id: "rule_1" };
	let calls = fakeFetch(200, { rules: [rule] });
	assert.deepEqual(await listBotRules("b1"), [rule]);
	assert.equal(calls[0]?.url, "/v1/bots/b1/rules");

	calls = fakeFetch(200, { rule });
	await patchBotRule("b1", "rule_1", { verdict: "deny", note: null });
	assert.deepEqual(calls[0], { url: "/v1/bots/b1/rules/rule_1", method: "PATCH", body: { verdict: "deny", note: null } });

	calls = fakeFetch(200, { rule });
	await deleteBotRule("b1", "rule_1");
	assert.deepEqual(calls[0], { url: "/v1/bots/b1/rules/rule_1", method: "DELETE", body: undefined });
});

test("sono: relatórios, mudanças, dispensar proposta e desfazer", async () => {
	let calls = fakeFetch(200, { reports: [], nextCursor: null });
	await listSleepReports({ botId: "b1", kind: "daily", limit: 7 });
	assert.equal(calls[0]?.url, "/v1/sleep/reports?botId=b1&kind=daily&limit=7");

	calls = fakeFetch(200, { changes: [], nextCursor: null });
	await listSleepChanges({ botId: "b1", reportId: "r1" });
	assert.equal(calls[0]?.url, "/v1/sleep/changes?botId=b1&reportId=r1");

	calls = fakeFetch(200, { report: { id: "r1" } });
	assert.deepEqual(await dismissSleepProposal("r1", "skill:x y"), { id: "r1" });
	assert.deepEqual(calls[0], { url: "/v1/sleep/reports/r1/proposals/skill%3Ax%20y/dismiss", method: "POST", body: undefined });

	calls = fakeFetch(200, { change: { id: "c2" } });
	assert.deepEqual(await undoMemoryChange("c1"), { id: "c2" });
	assert.deepEqual(calls[0], { url: "/v1/memory/changes/c1/undo", method: "POST", body: undefined });
});

test("erro 409 do servidor chega com o código em AtlasApiError.details", async () => {
	fakeFetch(409, { error: "mudou", code: "stale" });
	const error = await undoMemoryChange("c1").catch((caught: unknown) => caught);
	assert.ok(error instanceof AtlasApiError);
	assert.equal(error.status, 409);
	assert.equal(apiErrorCode(error), "stale");
	assert.equal(apiErrorCode(new Error("x")), null);
	assert.equal(apiErrorCode(new AtlasApiError("x", 500)), null);
});
