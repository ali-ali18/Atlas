/**
 * Motor v4 no worker, com portas falsas (sem banco, rede nem modelo).
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/engine-v4.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Llm, LlmChatRequest, LlmStreamEvent } from "@workspace/agent";
import type { ComputerUseEvent } from "@workspace/shared";
import { createMinimalEventMapper, meterLlm, runEngineV4, storeBackendFromDb, vaultBackendFromService, type V4Db } from "./engine-v4.js";

const served = { provider: "fake", model: "m-1" };
const done = (costUsd?: number): LlmStreamEvent => ({ type: "done", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, ...(costUsd !== undefined ? { costUsd } : {}) }, served });

function scripted(turns: LlmStreamEvent[][]): Llm & { requests: LlmChatRequest[] } {
	const requests: LlmChatRequest[] = [];
	return {
		requests,
		async contextWindow() {
			return 100_000;
		},
		async *chat(request) {
			requests.push(request);
			const turn = turns.shift();
			if (!turn) throw new Error("sem turno");
			for (const event of turn) yield event;
		},
	};
}

function fakeDb() {
	const calls: Array<{ fn: string; userId: string; lease?: unknown }> = [];
	const checkpoints = new Map<string, { runId: string; userId: string; step: number; state: string; payload: unknown }>();
	const db = {
		saveCheckpoint: async (userId: string, cp: { runId: string; userId: string; step: number; state: string; payload: unknown }, lease?: unknown) => {
			calls.push({ fn: "saveCheckpoint", userId, lease });
			checkpoints.set(`${userId}:${cp.runId}`, cp);
		},
		loadCheckpoint: async (userId: string, runId: string) => checkpoints.get(`${userId}:${runId}`) ?? null,
		appendJournal: async (e: { userId: string }) => void calls.push({ fn: "appendJournal", userId: e.userId }),
		findJournal: async () => null,
		listJournal: async () => [],
		appendReceipt: async (r: { userId: string }) => void calls.push({ fn: "appendReceipt", userId: r.userId }),
		listReceipts: async () => [],
		saveNote: async (n: { userId: string }) => void calls.push({ fn: "saveNote", userId: n.userId }),
		getNote: async () => null,
		listNotes: async () => [],
		removeNote: async () => false,
		getConversation: async () => ({ offers: [], declinedOffers: [] }),
		saveConversation: async (userId: string) => void calls.push({ fn: "saveConversation", userId }),
	} as unknown as V4Db;
	return { db, calls, checkpoints };
}

const baseInput = (llm: Llm, events: ComputerUseEvent[], db: V4Db) => ({
	runId: "run-1",
	userId: "user-a",
	objective: "Bom dia",
	llm,
	lease: { owner: "w1", token: "t1" },
	persistEvent: (e: ComputerUseEvent) => void events.push(e),
	limits: {},
	ownerPresent: true,
	db,
});

test("run simples: resposta do modelo vira texto, eventos do contrato SSE, uso e checkpoint com o lease", async () => {
	const events: ComputerUseEvent[] = [];
	const { db, calls, checkpoints } = fakeDb();
	const llm = scripted([[{ type: "text_delta", text: "Olá!" }, done(0.01)]]);
	const out = await runEngineV4(baseInput(llm, events, db));
	assert.equal(out.text, "Olá!");
	assert.equal(out.parked, false);
	assert.equal(out.hitWall, false);
	assert.deepEqual(out.stop, { reason: "answered" });
	assert.equal(out.model, "fake/m-1");
	assert.deepEqual(out.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.01 });
	assert.deepEqual(events.filter((e) => e.type === "assistant_delta").map((e) => (e as { delta: string }).delta), ["Olá!"]);
	assert.ok(calls.filter((c) => c.fn === "saveCheckpoint").every((c) => c.userId === "user-a" && JSON.stringify(c.lease) === JSON.stringify({ owner: "w1", token: "t1" })));
	assert.equal(checkpoints.get("user-a:run-1")?.state, "DONE");
	// o pedido do dono chegou ao modelo
	assert.match(JSON.stringify(llm.requests[0]?.messages), /Bom dia/);
});

test("lease perdido: o erro lease_lost do db sobe para o processador tratar", async () => {
	const { db } = fakeDb();
	db.saveCheckpoint = async () => {
		throw new Error("lease_lost");
	};
	await assert.rejects(runEngineV4(baseInput(scripted([[{ type: "text_delta", text: "x" }, done()]]), [], db)), /lease_lost/);
});

test("falha do modelo vira erro (nunca sucesso falso) e 'Parar' propaga o abort", async () => {
	const { db } = fakeDb();
	const failing: Llm = {
		async contextWindow() {
			return 1000;
		},
		// eslint-disable-next-line require-yield
		async *chat() {
			throw new Error("provedor caiu");
		},
	};
	await assert.rejects(runEngineV4(baseInput(failing, [], db)), /Motor v4 falhou/);
	const controller = new AbortController();
	controller.abort(new Error("parar"));
	await assert.rejects(runEngineV4({ ...baseInput(scripted([[{ type: "text_delta", text: "x" }, done()]]), [], db), signal: controller.signal }));
});

test("limite de gasto do dono vira stop budget_cost e passo de segurança vira hitWall", async () => {
	const { db } = fakeDb();
	const events: ComputerUseEvent[] = [];
	const out = await runEngineV4({ ...baseInput(scripted([[{ type: "text_delta", text: "a" }, { type: "tool_call", call: { id: "c1", name: "note_read", args: { id: "x" } } }, done(5)], [{ type: "text_delta", text: "resumo" }, done(0.1)]]), events, db), limits: { ownerMaxUsd: 1 } });
	assert.deepEqual(out.stop, { reason: "budget_cost" });
	assert.equal(out.hitWall, false);
	const steps = await runEngineV4({ ...baseInput(scripted([[{ type: "tool_call", call: { id: "c1", name: "note_read", args: { id: "x" } } }, done()], [{ type: "text_delta", text: "fim" }, done()]]), [], db), runId: "run-2", limits: { ownerMaxSteps: 1 } });
	assert.deepEqual(steps.stop, { reason: "budget_steps" });
	assert.equal(steps.hitWall, true);
});

test("pergunta ao dono (ask_owner) encerra o turno com stop awaiting_confirmation", async () => {
	const { db } = fakeDb();
	const out = await runEngineV4(baseInput(scripted([[{ type: "tool_call", call: { id: "c1", name: "ask_owner", args: { question: "Qual?" } } }, done()]]), [], db));
	assert.equal(out.stop.reason, "awaiting_confirmation");
});

test("o mapa mínimo de eventos converte texto, chamada e resultado e ignora o resto", () => {
	const map = createMinimalEventMapper("r");
	assert.deepEqual(map({ type: "step", runId: "r", userId: "u", data: { step: 2, final: false } }), []);
	assert.deepEqual(map({ type: "text_delta", runId: "r", userId: "u", data: { text: "oi" } }), [{ type: "assistant_delta", id: "r:2", delta: "oi" }]);
	assert.deepEqual(map({ type: "tool_call", runId: "r", userId: "u", data: { callId: "c", name: "n", args: { a: 1 } } }), [{ type: "tool_call", id: "c", name: "n", args: '{"a":1}', step: 2 }]);
	assert.deepEqual(map({ type: "tool_result", runId: "r", userId: "u", data: { callId: "c", name: "n", status: "error", content: "x" } }), [{ type: "tool_result", id: "c", name: "n", ok: false, summary: "x" }]);
	assert.deepEqual(map({ type: "card", runId: "r", userId: "u", data: {} }), []);
});

test("meterLlm soma o uso e marca custo desconhecido; vault expõe só segredos simples e o dono", async () => {
	const meter = meterLlm(scripted([[done(0.5)], [done()]]));
	for (const _ of [1, 2]) for await (const _event of meter.llm.chat({ role: "main", messages: [] })) void _event;
	assert.deepEqual(meter.usage(), { promptTokens: 20, completionTokens: 10, totalTokens: 30, costUsd: 0.5, costUnknownCalls: 1 });

	const calls: string[] = [];
	const backend = vaultBackendFromService({
		listMeta: async (userId) => (userId === "a" ? [{ kind: "secret", name: "api", label: "" }, { kind: "login", name: "site", label: "Site" }] : []),
		resolveRef: async (userId, ref) => {
			calls.push(`${userId}:${ref.name}`);
			return userId === "a" && ref.name === "api" ? { value: "valor" } : null;
		},
	});
	assert.deepEqual(await backend.listHandles("a"), [{ id: "api", label: "api" }]);
	assert.deepEqual(await backend.listHandles("b"), []);
	assert.equal(await backend.resolveSecret("a", "api"), "valor");
	assert.equal(await backend.resolveSecret("b", "api"), null);
});

test("store do worker: setStatus não grava no banco e o recibo/nota passam o dono", async () => {
	const { db, calls } = fakeDb();
	const store = storeBackendFromDb(db, null);
	await store.setStatus("a", "r", "done");
	await store.saveNote({ id: "n", userId: "a", title: "t", body: "b", pinned: false });
	assert.deepEqual(calls.map((c) => [c.fn, c.userId]), [["saveNote", "a"]]);
});
