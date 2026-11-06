/**
 * Fumaça do motor v4 (F1.14): preset `minimal` ponta a ponta no caminho real do worker (`runEngineV4` + adaptadores
 * reais + `createSseMapper`), com modelo roteirizado, busca e arquivo falsos e db em memória. Sem rede.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/engine-v4.smoke.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createSseMapper, FakeFileStore, FakeSearch, setupPreset, type Llm, type LlmChatRequest, type LlmStreamEvent } from "@workspace/agent";
import { applyComputerUseEventsToTranscript, isAgentV4EventType, parseAgentV4Event, type ComputerUseEvent } from "@workspace/shared";
import { runEngineV4, type V4Db } from "./engine-v4.js";

const served = { provider: "fake", model: "m-1" };
const done = (finishReason: "stop" | "tool_calls"): LlmStreamEvent => ({ type: "done", finishReason, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 }, served });
const say = (text: string): LlmStreamEvent[] => [{ type: "text_delta", text }, done("stop")];
const callTool = (id: string, name: string, args: unknown): LlmStreamEvent[] => [{ type: "tool_call", call: { id, name, args } }, done("tool_calls")];

function scripted(turns: LlmStreamEvent[][]): Llm & { requests: LlmChatRequest[] } {
	const requests: LlmChatRequest[] = [];
	return {
		requests,
		contextWindow: async () => 100_000,
		async *chat(request) {
			requests.push(structuredClone({ ...request, signal: undefined }));
			const turn = turns.shift();
			if (!turn) throw new Error("sem turno no roteiro");
			for (const event of turn) yield event;
		},
	};
}

function memoryDb() {
	const checkpoints = new Map<string, { state: string }>();
	const receipts: unknown[] = [];
	const journal: unknown[] = [];
	const db = {
		saveCheckpoint: async (userId: string, cp: { runId: string; state: string }) => void checkpoints.set(`${userId}:${cp.runId}`, cp),
		loadCheckpoint: async (userId: string, runId: string) => checkpoints.get(`${userId}:${runId}`) ?? null,
		appendJournal: async (e: unknown) => void journal.push(e),
		findJournal: async () => null,
		listJournal: async () => [],
		appendReceipt: async (r: unknown) => void receipts.push(r),
		listReceipts: async () => [],
		saveNote: async () => undefined,
		getNote: async () => null,
		listNotes: async () => [],
		removeNote: async () => false,
		getConversation: async () => ({ offers: [], declinedOffers: [] }),
		saveConversation: async () => undefined,
	} as unknown as V4Db;
	return { db, checkpoints, receipts, journal };
}

const realFetch = globalThis.fetch;
let networkCalls = 0;
beforeEach(() => {
	networkCalls = 0;
	globalThis.fetch = (async () => {
		networkCalls += 1;
		throw new Error("rede proibida no teste de fumaça");
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

async function smoke(objective: string, turns: LlmStreamEvent[][]) {
	const search = new FakeSearch();
	const files = new FakeFileStore();
	const setup = setupPreset("minimal", { search, files });
	const llm = scripted(turns);
	const mem = memoryDb();
	const events: ComputerUseEvent[] = [];
	const mapper = createSseMapper({ runId: "run-smoke", model: "fake/m-1" });
	const out = await runEngineV4({
		runId: "run-smoke",
		userId: "user-a",
		objective,
		llm,
		lease: { owner: "w1", token: "t1" },
		persistEvent: (e) => void events.push(e),
		mapEvent: (e) => mapper.mapRunEvent(e),
		limits: {},
		ownerPresent: true,
		db: mem.db,
		registry: setup.registry,
		stableSystem: setup.stableSystem,
	});
	// Contrato: todo evento tem `type` string; os eventos novos do v4 passam no parser tipado.
	for (const event of events) {
		assert.equal(typeof event.type, "string");
		if (isAgentV4EventType(event.type)) assert.ok(parseAgentV4Event(event), `evento v4 malformado: ${JSON.stringify(event)}`);
	}
	const bubbles = applyComputerUseEventsToTranscript([], events);
	assert.equal(mem.checkpoints.get("user-a:run-smoke")?.state, "DONE", "checkpoint final salvo");
	assert.equal(networkCalls, 0, "nada chamou a rede");
	assert.equal(events.at(-1)?.type, "done");
	assert.ok(!llm.requests.some((r) => JSON.stringify(r.messages).includes("Work contract")), "minimal não leva o contrato de trabalho");
	return { out, events, bubbles, search, files, llm, mem };
}

const types = (events: ComputerUseEvent[]) => events.map((e) => e.type);

test("(a) Bom dia: resposta em texto, sem tools, done", async () => {
	const { out, events, bubbles, llm } = await smoke("Bom dia", [say("Bom dia! Como posso ajudar?")]);
	assert.equal(out.text, "Bom dia! Como posso ajudar?");
	assert.deepEqual(out.stop, { reason: "answered" });
	assert.equal(llm.requests.length, 1);
	assert.ok(!types(events).includes("tool_call"));
	assert.deepEqual(bubbles.filter((b) => b.kind === "assistant").map((b) => b.text), ["Bom dia! Como posso ajudar?"]);
});

test("(b) pesquisa: web_search, resposta com a URL, done", async () => {
	const { out, events, bubbles, search, llm } = await smoke("pesquisa Atlas", [
		callTool("c1", "web_search", { query: "Atlas" }),
		say("Achei: https://example.test/resultado"),
	]);
	assert.deepEqual(search.queries, [{ userId: "user-a", query: "Atlas" }]);
	assert.match(out.text, /https:\/\/example\.test\/resultado/);
	assert.deepEqual(types(events).filter((t) => t === "tool_call" || t === "tool_result"), ["tool_call", "tool_result"]);
	const result = events.find((e) => e.type === "tool_result") as { ok: boolean; name: string };
	assert.equal(result.ok, true);
	assert.equal(result.name, "web_search");
	assert.ok(bubbles.some((b) => b.kind === "assistant" && b.text.includes("https://example.test/resultado")));
	// o resultado da web volta ao modelo como dado de canal, no segundo passo
	assert.match(JSON.stringify(llm.requests[1]?.messages), /Resultado de teste/);
});

test("(c) arquivo: create_file grava, emite recibo e a resposta fecha o run", async () => {
	const { out, events, files, mem, bubbles } = await smoke("cria um arquivo .md com Y", [
		callTool("c1", "create_file", { name: "y.md", content: "# Y" }),
		say("Criei o arquivo y.md."),
	]);
	assert.deepEqual(files.files.map((f) => ({ userId: f.userId, name: f.name, content: f.content })), [{ userId: "user-a", name: "y.md", content: "# Y" }]);
	const receipt = events.find((e) => e.type === "receipt") as { type: "receipt"; what: string; externalId?: string } | undefined;
	assert.ok(receipt, "evento de recibo");
	assert.match(receipt.what, /y\.md/);
	assert.equal(receipt.externalId, "file-1");
	assert.equal(mem.receipts.length, 1);
	assert.ok(mem.journal.length > 0, "efeito passou pelo journal");
	assert.equal(out.text, "Criei o arquivo y.md.");
	assert.ok(bubbles.some((b) => b.kind === "assistant" && b.text === "Criei o arquivo y.md."));
});
