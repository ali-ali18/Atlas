import assert from "node:assert/strict";
import test from "node:test";
import { AtlasApiError } from "@/lib/atlas-api";
import { change, note, report, rule } from "./fixtures";
import { changeRule, createOwnerNote, dismissProposal, editOwnerNote, type NotebookApi, pinOwnerNote, removeOwnerNote, removeRule, undoChange } from "./notebook-actions";

/** Cliente falso: guarda cada chamada e responde o que o teste mandar. Nada de rede. */
function fakeApi(overrides: Partial<NotebookApi> = {}): { api: NotebookApi; calls: Array<[string, ...unknown[]]> } {
	const calls: Array<[string, ...unknown[]]> = [];
	const record = <T>(name: string, value: T) => async (...args: unknown[]): Promise<T> => {
		calls.push([name, ...args]);
		return value;
	};
	const api: NotebookApi = {
		listNotes: record("listNotes", { notes: [], limit: 500 }),
		createNote: record("createNote", note()),
		updateNote: record("updateNote", note({ pinned: true })),
		deleteNote: record("deleteNote", undefined),
		listBotRules: record("listBotRules", [rule()]),
		patchBotRule: record("patchBotRule", rule({ verdict: "deny" })),
		deleteBotRule: record("deleteBotRule", undefined),
		listSleepReports: record("listSleepReports", { reports: [], nextCursor: null }),
		listSleepChanges: record("listSleepChanges", { changes: [], nextCursor: null }),
		dismissSleepProposal: record("dismissSleepProposal", report()),
		undoMemoryChange: record("undoMemoryChange", change({ id: "c9", undoOfId: "c1" })),
		...overrides,
	} as NotebookApi;
	return { api, calls };
}

const failing = (status: number, code?: string) => async () => {
	throw new AtlasApiError("x", status, code ? { code } : undefined);
};

test("criar nota: valida antes, aparam o título e manda o escopo escolhido", async () => {
	const { api, calls } = fakeApi();
	assert.deepEqual(await createOwnerNote(api, { title: " ", body: "x", botId: null }), { ok: false, message: "Dê um título à nota." });
	assert.equal(calls.length, 0, "rascunho inválido não chega ao servidor");
	const ok = await createOwnerNote(api, { title: "  Viagem ", body: "Texto", botId: "b1" });
	assert.equal(ok.ok, true);
	assert.deepEqual(calls, [["createNote", { title: "Viagem", body: "Texto", botId: "b1" }]]);
});

test("criar nota: limite e repetida viram frase simples", async () => {
	const limit = await createOwnerNote(fakeApi({ createNote: failing(409, "limit") }).api, { title: "t", body: "b", botId: null });
	assert.deepEqual(limit, { ok: false, message: "O caderno está cheio (500 notas). Apague alguma para guardar outra." });
	const dup = await createOwnerNote(fakeApi({ createNote: failing(409, "duplicate") }).api, { title: "t", body: "b", botId: null });
	assert.deepEqual(dup, { ok: false, message: "Já existe uma nota com esse mesmo texto." });
});

test("editar, fixar e desafixar chamam o cliente com o campo certo", async () => {
	const { api, calls } = fakeApi();
	await editOwnerNote(api, "n1", { title: " Novo ", body: "Corpo" });
	await pinOwnerNote(api, "n1", true);
	await pinOwnerNote(api, "n1", false);
	assert.deepEqual(calls, [
		["updateNote", "n1", { title: "Novo", body: "Corpo" }],
		["updateNote", "n1", { pinned: true }],
		["updateNote", "n1", { pinned: false }],
	]);
	const conflict = await editOwnerNote(fakeApi({ updateNote: failing(409, "conflict") }).api, "n1", { title: "t", body: "b" });
	assert.equal(conflict.ok === false && /mudou enquanto você mexia/.test(conflict.message), true);
});

test("apagar nota e regra: sucesso chama o cliente; falha vira frase (404 e geral)", async () => {
	const { api, calls } = fakeApi();
	assert.deepEqual(await removeOwnerNote(api, "n1"), { ok: true, value: true });
	assert.deepEqual(await removeRule(api, "b1", "rule_1"), { ok: true, value: true });
	assert.deepEqual(calls, [["deleteNote", "n1"], ["deleteBotRule", "b1", "rule_1"]]);
	assert.deepEqual(await removeOwnerNote(fakeApi({ deleteNote: failing(404) }).api, "n1"), { ok: false, message: "Essa nota não existe mais." });
	assert.deepEqual(await removeOwnerNote(fakeApi({ deleteNote: failing(500) }).api, "n1"), { ok: false, message: "Não consegui apagar a nota. Tente de novo." });
	assert.deepEqual(await removeRule(fakeApi({ deleteBotRule: failing(503) }).api, "b1", "r"), { ok: false, message: "Não consegui apagar a regra. Tente de novo." });
});

test("editar regra: manda veredito e observação; 422 acima do teto vira frase", async () => {
	const { api, calls } = fakeApi();
	const result = await changeRule(api, "b1", "rule_1", { verdict: "deny", note: "Cliente pediu" });
	assert.equal(result.ok && result.value.verdict, "deny");
	assert.deepEqual(calls, [["patchBotRule", "b1", "rule_1", { verdict: "deny", note: "Cliente pediu" }]]);
	const ceiling = await changeRule(fakeApi({ patchBotRule: failing(422, "refused") }).api, "b1", "rule_1", { verdict: "run" });
	assert.deepEqual(ceiling, { ok: false, message: "O bot já tem regras demais. Apague algumas antes de mudar." });
});

test("desfazer e dispensar: chamam o cliente; 409 do desfazer vira a frase do motivo", async () => {
	const { api, calls } = fakeApi();
	assert.equal((await undoChange(api, "c1")).ok, true);
	assert.equal((await dismissProposal(api, "r1", "skill:x")).ok, true);
	assert.deepEqual(calls, [["undoMemoryChange", "c1"], ["dismissSleepProposal", "r1", "skill:x"]]);
	for (const [code, text] of [["stale", /mudou depois/], ["duplicate", /algo igual/], ["limit", /Não coube/], ["already_undone", /já tinha sido desfeito/]] as const) {
		const result = await undoChange(fakeApi({ undoMemoryChange: failing(409, code) }).api, "c1");
		assert.equal(result.ok === false && text.test(result.message), true, code);
	}
	const dismissFailed = await dismissProposal(fakeApi({ dismissSleepProposal: failing(404) }).api, "r1", "p");
	assert.deepEqual(dismissFailed, { ok: false, message: "Não consegui dispensar. Tente de novo." });
});
