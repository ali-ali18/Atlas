import { createHash } from "node:crypto";
import {
	createEventsAdapter,
	chainsForAllRoles,
	createLlmAdapter,
	createQueueAdapter,
	createSseMapper,
	createStoreAdapter,
	createSystemClock,
	createSystemRandom,
	createVaultAdapter,
	FakeFileStore,
	FakeSearch,
	runAgent,
	setupPreset,
	type JournalEntry,
	type Note,
	type Sandbox,
	type StoredReceipt,
	type StoreBackend,
} from "@workspace/agent";
import { parseModelRef, type ComputerUseEvent, type RunStop } from "@workspace/shared";
import { EVAL_USER_ID } from "./environment.js";
import type { StreamChat } from "./mock-model.js";
import type { Scenario } from "./scenario.js";

/**
 * Motor v4 no eval (F1.14): `runAgent` com o preset `minimal` (web e arquivo) e portas em memória. É a ponta que faz
 * `matrix --engines v4` rodar o pipeline inteiro; NÃO é paridade com o legado. Limites conhecidos:
 *  - só existem `web_search`, `web_extract` e `create_file`, respondidas por `FakeSearch`/`FakeFileStore`. Os fixtures
 *    de conector do cenário (agenda, e-mail…) não são ligados: cenário que depende deles falha por falta de capacidade
 *    (a F2 traz as capacidades reais e as fixtures por porta);
 *  - o histórico do cenário entra como falas do dono/assistente em texto (turnos com tool viram nota de texto).
 */

const sha256 = (payload: string): string => createHash("sha256").update(payload).digest("hex");

function memoryBackend(): StoreBackend {
	const checkpoints = new Map<string, { runId: string; userId: string; step: number; state: string; payload: unknown }>();
	const journal: JournalEntry[] = [];
	const receipts: StoredReceipt[] = [];
	const notes = new Map<string, Note>();
	const conversations = new Map<string, { offers: never[]; declinedOffers: string[] }>();
	return {
		saveCheckpoint: async (userId, cp) => void checkpoints.set(`${userId}:${cp.runId}`, cp),
		loadCheckpoint: async (userId, runId) => checkpoints.get(`${userId}:${runId}`) ?? null,
		setStatus: async () => undefined,
		appendJournal: async (entry) => void journal.push(entry),
		findJournal: async (userId, runId, key) => [...journal].reverse().find((e) => e.userId === userId && e.runId === runId && e.idempotencyKey === key) ?? null,
		listJournal: async (userId, runId) => journal.filter((e) => e.userId === userId && e.runId === runId),
		appendReceipt: async (receipt) => void receipts.push(receipt),
		listReceipts: async (userId, runId) => receipts.filter((r) => r.userId === userId && r.runId === runId),
		saveNote: async (note) => void notes.set(`${note.userId}:${note.id}`, note),
		getNote: async (userId, id) => notes.get(`${userId}:${id}`) ?? null,
		listNotes: async (userId) => [...notes.values()].filter((n) => n.userId === userId),
		removeNote: async (userId, id) => notes.delete(`${userId}:${id}`),
		getConversation: async (userId, id) => conversations.get(`${userId}:${id}`) ?? { offers: [], declinedOffers: [] },
		saveConversation: async (userId, id, state) => void conversations.set(`${userId}:${id}`, state as { offers: never[]; declinedOffers: string[] }),
	};
}

const noSandbox: Sandbox = { run: async () => ({ ok: false, error: "Sem VM no eval do motor v4." }), release: async () => undefined };

export type RunV4Params = {
	scenario: Scenario;
	apiKey: string;
	model: string;
	runId: string;
	streamChat: StreamChat;
	maxSteps: number;
	signal: AbortSignal;
	onEvent: (event: ComputerUseEvent) => void;
};

export async function runScenarioV4(params: RunV4Params): Promise<{ text: string; stop: RunStop }> {
	const { scenario } = params;
	const setup = setupPreset("minimal", { search: new FakeSearch(), files: new FakeFileStore() });
	const ref = parseModelRef(params.model);
	const entry = { provider: ref.provider, model: ref.slug };
	const chains = chainsForAllRoles(entry);
	const clock = createSystemClock();
	const mapper = createSseMapper({ runId: params.runId, model: params.model });
	const history = [
		...scenario.history.map((message) => {
			const text = "content" in message && typeof message.content === "string" ? message.content : "";
			return message.role === "assistant" ? ({ kind: "assistant", text } as const) : ({ kind: "owner", text } as const);
		}),
		{ kind: "owner", text: scenario.user } as const,
	].filter((item) => item.text.length > 0);
	const result = await runAgent({
		runId: params.runId,
		ownerId: EVAL_USER_ID,
		input: { stableSystem: setup.stableSystem, contextSections: [], history: history as never },
		ports: {
			llm: createLlmAdapter({ streamChat: params.streamChat as never, chains, apiKeyFor: () => params.apiKey || "eval", clock }),
			store: createStoreAdapter(memoryBackend()),
			queue: createQueueAdapter({ add: async () => { throw new Error("Sem fila no eval do motor v4."); }, getJob: async () => null }),
			sandbox: noSandbox,
			vault: createVaultAdapter({ listHandles: async () => [], resolveSecret: async () => null }),
			clock,
			random: createSystemRandom(),
			events: createEventsAdapter({ runId: params.runId, userId: EVAL_USER_ID, map: (event) => mapper.mapRunEvent(event), persist: params.onEvent }),
		},
		registry: setup.registry,
		policy: { surface: "chat", ownerPresent: true, autonomy: "balanced", rules: [] },
		limits: { ownerMaxSteps: params.maxSteps },
		hash: sha256,
		signal: params.signal,
	});
	if (result.status === "failed") throw new Error(`Motor v4 falhou: ${result.reason ?? "erro desconhecido"}`);
	return { text: result.text, stop: { reason: result.stop?.kind === "cost" ? "budget_cost" : result.stop ? "budget_steps" : "answered" } };
}
