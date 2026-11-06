import { describe, expect, it } from "vitest";
import type { ComputerUseEvent } from "@workspace/shared";
import { inspect } from "node:util";
import type { RunCheckpoint } from "../ports/store.js";
import { createSystemClock } from "./clock.js";
import { createEventsAdapter } from "./events.js";
import { createQueueAdapter, dedupeJobId, type BullLikeQueue } from "./queue.js";
import { AGENDA_UNAVAILABLE, createStoreAdapter, type StoreBackend } from "./store.js";
import { createVaultAdapter } from "./vault.js";

/** Backend em memória que filtra por dono como o do banco: serve para provar que o adaptador repassa o `userId`. */
function memoryBackend(): StoreBackend & { statuses: string[] } {
	const checkpoints = new Map<string, RunCheckpoint>();
	const journal: Array<Parameters<StoreBackend["appendJournal"]>[0]> = [];
	const notes = new Map<string, Parameters<StoreBackend["saveNote"]>[0]>();
	const conversations = new Map<string, Awaited<ReturnType<StoreBackend["getConversation"]>>>();
	const receipts: Array<Parameters<StoreBackend["appendReceipt"]>[0]> = [];
	const statuses: string[] = [];
	return {
		statuses,
		async saveCheckpoint(userId, cp) {
			checkpoints.set(`${userId}:${cp.runId}`, structuredClone(cp));
		},
		async loadCheckpoint(userId, runId) {
			return checkpoints.get(`${userId}:${runId}`) ?? null;
		},
		async setStatus(userId, runId, status) {
			statuses.push(`${userId}:${runId}:${status}`);
		},
		async appendJournal(entry) {
			journal.push(entry);
		},
		async findJournal(userId, runId, key) {
			return journal.find((e) => e.userId === userId && e.runId === runId && e.idempotencyKey === key) ?? null;
		},
		async listJournal(userId, runId) {
			return journal.filter((e) => e.userId === userId && e.runId === runId);
		},
		async appendReceipt(r) {
			receipts.push(r);
		},
		async listReceipts(userId, runId) {
			return receipts.filter((r) => r.userId === userId && r.runId === runId);
		},
		async saveNote(n) {
			notes.set(`${n.userId}:${n.id}`, n);
		},
		async getNote(userId, id) {
			return notes.get(`${userId}:${id}`) ?? null;
		},
		async listNotes(userId) {
			return [...notes.values()].filter((n) => n.userId === userId);
		},
		async removeNote(userId, id) {
			return notes.delete(`${userId}:${id}`);
		},
		async getConversation(userId, id) {
			return conversations.get(`${userId}:${id}`) ?? { offers: [], declinedOffers: [] };
		},
		async saveConversation(userId, id, state) {
			conversations.set(`${userId}:${id}`, structuredClone(state));
		},
	};
}

describe("createStoreAdapter", () => {
	it("checkpoint, journal, recibos, notas e conversas passam o dono às funções injetadas", async () => {
		const store = createStoreAdapter(memoryBackend());
		const cp: RunCheckpoint = { runId: "r1", userId: "a", step: 2, state: "TOOLS", payload: { v: 1 } };
		await store.runs.saveCheckpoint(cp);
		expect(await store.runs.loadCheckpoint("a", "r1")).toEqual(cp);
		expect(await store.runs.loadCheckpoint("b", "r1")).toBeNull();

		const entry = { runId: "r1", userId: "a", step: 1, idempotencyKey: "k", toolName: "send", argsHash: "h", outcome: "started" as const };
		await store.journal.append(entry);
		expect(await store.journal.find("a", "r1", "k")).toEqual(entry);
		expect(await store.journal.find("b", "r1", "k")).toBeNull();
		expect(await store.journal.list("b", "r1")).toEqual([]);

		const receipt = { runId: "r1", userId: "a", toolName: "send", effect: "send", summary: "ok", at: new Date(0) };
		await store.receipts.append(receipt);
		expect(await store.receipts.listForRun("a", "r1")).toEqual([receipt]);
		expect(await store.receipts.listForRun("b", "r1")).toEqual([]);

		await store.notes.save({ id: "n", userId: "a", title: "t", body: "b", pinned: false });
		expect(await store.notes.get("b", "n")).toBeNull();
		await store.notes.remove("b", "n");
		expect((await store.notes.get("a", "n"))?.body).toBe("b");
		await store.notes.remove("a", "n");
		expect(await store.notes.list("a")).toEqual([]);

		const state = { offers: [{ cardId: "c", label: "L", state: "open" as const }], declinedOffers: ["X"] };
		await store.conversations.save("a", "conv", state);
		expect(await store.conversations.get("a", "conv")).toEqual(state);
		expect(await store.conversations.get("b", "conv")).toEqual({ offers: [], declinedOffers: [] });
	});

	it("estado de checkpoint desconhecido (outra versão) vira 'sem checkpoint'", async () => {
		const backend = memoryBackend();
		backend.loadCheckpoint = async () => ({ runId: "r", userId: "a", step: 1, state: "FUTURE", payload: {} });
		expect(await createStoreAdapter(backend).runs.loadCheckpoint("a", "r")).toBeNull();
	});

	it("setStatus repassa o status e a agenda indisponível falha com a mensagem real", async () => {
		const backend = memoryBackend();
		const store = createStoreAdapter(backend);
		await store.runs.setStatus("a", "r1", "parked");
		expect(backend.statuses).toEqual(["a:r1:parked"]);
		await expect(store.agenda.upsert({ id: "1", userId: "a", kind: "reminder", dueAt: null, spec: {}, ignoredStreak: 0, status: "active" })).rejects.toThrow(AGENDA_UNAVAILABLE);
		// texto que volta ao modelo (60-agente): inglês e sem nome interno (auditoria F1, A2)
		expect(AGENDA_UNAVAILABLE).toMatch(/^Scheduling is not available/);
		expect(AGENDA_UNAVAILABLE).not.toMatch(/v4|motor|agenda/i);
		expect(await store.agenda.get("a", "1")).toBeNull();
		expect(await store.agenda.listActive("a")).toEqual([]);
	});
});

describe("createQueueAdapter", () => {
	function fakeQueue() {
		const jobs = new Map<string, { data: unknown; opts: unknown; removed: boolean }>();
		let seq = 0;
		const queue: BullLikeQueue = {
			async add(name, data, opts) {
				const id = opts?.jobId ?? String(++seq);
				jobs.set(id, { data: { ...data, name }, opts, removed: false });
				return { id };
			},
			async getJob(id) {
				const job = jobs.get(id);
				return job && !job.removed ? { data: job.data, remove: async () => void (job.removed = true) } : null;
			},
		};
		return { queue, jobs };
	}

	it("enfileira com atraso e id estável por (dono, chave); chave de outro dono não colide", async () => {
		const { queue, jobs } = fakeQueue();
		const adapter = createQueueAdapter(queue);
		const a = await adapter.enqueue({ name: "reminder", userId: "a", payload: { x: 1 }, delayMs: 1500.4, dedupeKey: "item:1" });
		const b = await adapter.enqueue({ name: "reminder", userId: "b", payload: {}, dedupeKey: "item:1" });
		expect(a.jobId).toBe(dedupeJobId("a", "item:1"));
		expect(a.jobId).not.toBe(b.jobId);
		expect(a.jobId).not.toContain(":");
		expect(jobs.get(a.jobId)?.opts).toEqual({ delay: 1500, jobId: a.jobId });
		expect((await adapter.enqueue({ name: "n", userId: "a", payload: null })).jobId).toBe("1");
	});

	it("cancel só remove job do próprio dono", async () => {
		const { queue } = fakeQueue();
		const adapter = createQueueAdapter(queue);
		const { jobId } = await adapter.enqueue({ name: "reminder", userId: "a", payload: {} });
		expect(await adapter.cancel("b", jobId)).toBe(false);
		expect(await adapter.cancel("a", jobId)).toBe(true);
		expect(await adapter.cancel("a", jobId)).toBe(false);
		expect(await adapter.cancel("a", "inexistente")).toBe(false);
	});

	it("recusa dono vazio/default, nome vazio e atraso inválido", async () => {
		const adapter = createQueueAdapter(fakeQueue().queue);
		await expect(adapter.enqueue({ name: "n", userId: "default", payload: {} })).rejects.toThrow(/no valid owner/);
		await expect(adapter.enqueue({ name: " ", userId: "a", payload: {} })).rejects.toThrow(/has no name/);
		for (const delayMs of [-1, Number.NaN, 366 * 24 * 3600 * 1000]) await expect(adapter.enqueue({ name: "n", userId: "a", payload: {}, delayMs })).rejects.toThrow(RangeError);
	});
});

describe("createEventsAdapter", () => {
	const delta = (text: string): ComputerUseEvent => ({ type: "assistant_delta", id: "m1", delta: text });

	it("entrega os eventos já mapeados na ordem e um de cada vez", async () => {
		const seen: string[] = [];
		const events = createEventsAdapter({
			runId: "r1",
			userId: "a",
			map: (e) => (e.type === "text_delta" ? [delta((e.data as { text: string }).text)] : e.type === "ignored" ? [] : [delta("1"), delta("2")]),
			persist: async (e) => {
				await new Promise((resolve) => setTimeout(resolve, 1));
				seen.push((e as { delta: string }).delta);
			},
		});
		await events.emit({ type: "text_delta", runId: "r1", userId: "a", data: { text: "oi" } });
		await events.emit({ type: "ignored", runId: "r1", userId: "a" });
		await events.emit({ type: "step", runId: "r1", userId: "a" });
		expect(seen).toEqual(["oi", "1", "2"]);
	});

	it("recusa evento de outro run ou de outro dono e propaga a falha de gravação", async () => {
		const persisted: unknown[] = [];
		const events = createEventsAdapter({ runId: "r1", userId: "a", map: () => [delta("x")], persist: (e) => void persisted.push(e) });
		await expect(events.emit({ type: "t", runId: "r2", userId: "a" })).rejects.toThrow(/outro run/);
		await expect(events.emit({ type: "t", runId: "r1", userId: "b" })).rejects.toThrow(/outro dono/);
		expect(persisted).toEqual([]);
		const failing = createEventsAdapter({ runId: "r1", userId: "a", map: () => [delta("x")], persist: () => Promise.reject(new Error("db caiu")) });
		await expect(failing.emit({ type: "t", runId: "r1", userId: "a" })).rejects.toThrow("db caiu");
	});
});

describe("createVaultAdapter", () => {
	const backend = {
		listHandles: async (userId: string) => (userId === "a" ? [{ id: "h1", label: "Banco", value: "extra-que-nao-pode-vazar" }] : []),
		resolveSecret: async (userId: string, id: string) => (userId === "a" && id === "h1" ? "s3nha-real" : null),
	};

	it("lista só id e rótulo e entrega o valor apenas por reveal()", async () => {
		const vault = createVaultAdapter(backend);
		expect(await vault.listHandles("a")).toEqual([{ id: "h1", label: "Banco" }]);
		const secret = await vault.resolve("a", "h1");
		expect(secret?.reveal()).toBe("s3nha-real");
		for (const text of [JSON.stringify({ secret }), `${secret}`, inspect(secret)]) expect(text).not.toContain("s3nha-real");
	});

	it("handle de outro dono ou inexistente = null", async () => {
		const vault = createVaultAdapter(backend);
		expect(await vault.resolve("b", "h1")).toBeNull();
		expect(await vault.resolve("a", "nope")).toBeNull();
		expect(await vault.listHandles("b")).toEqual([]);
	});
});

describe("createSystemClock", () => {
	it("devolve a hora de agora", () => {
		const before = Date.now();
		const now = createSystemClock().now().getTime();
		expect(now).toBeGreaterThanOrEqual(before);
		expect(now).toBeLessThanOrEqual(Date.now());
	});
});
