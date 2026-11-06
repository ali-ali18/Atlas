// Store em memória do run filho (decisão F3.1): o ajudante NÃO grava checkpoint, journal, recibo nem nota no banco do run
// da mãe. Tudo vive e morre com o ajudante: o caderno de trabalho dele (saída grande de tool paginada com `note_read`)
// fica aqui, escopado pelo dono como o resto. Um ajudante interrompido refaz do zero (não há retomada de filho).
import { createStoreAdapter, type StoreBackend } from "../adapters/store.js";
import type { JournalEntry, Note, Store, StoredReceipt } from "../ports/store.js";

export function createMemoryStoreBackend(): StoreBackend {
	const checkpoints = new Map<string, { runId: string; userId: string; step: number; state: string; payload: unknown }>();
	const journal: JournalEntry[] = [];
	const receipts: StoredReceipt[] = [];
	const notes = new Map<string, Note>();
	const conversations = new Map<string, { offers: never[]; declinedOffers: string[] }>();
	const key = (userId: string, id: string) => `${userId}:${id}`;
	return {
		async saveCheckpoint(userId, checkpoint) {
			// O kernel entrega o objeto vivo: copia dentro da chamada (contrato de `RunCheckpoint.payload`).
			checkpoints.set(key(userId, checkpoint.runId), { ...checkpoint, payload: structuredClone(checkpoint.payload) });
		},
		async loadCheckpoint(userId, runId) {
			const saved = checkpoints.get(key(userId, runId));
			return saved ? { ...saved, payload: structuredClone(saved.payload) } : null;
		},
		async setStatus() {},
		async appendJournal(entry) {
			if (entry.outcome === "started") {
				const prior = [...journal].reverse().find((e) => e.userId === entry.userId && e.runId === entry.runId && e.idempotencyKey === entry.idempotencyKey);
				if (prior && prior.outcome !== "failed") return { claimed: false };
			}
			journal.push(entry);
			return { claimed: true };
		},
		async findJournal(userId, runId, idempotencyKey) {
			return [...journal].reverse().find((e) => e.userId === userId && e.runId === runId && e.idempotencyKey === idempotencyKey) ?? null;
		},
		async listJournal(userId, runId) {
			return journal.filter((e) => e.userId === userId && e.runId === runId);
		},
		async appendReceipt(receipt) {
			receipts.push(receipt);
		},
		async listReceipts(userId, runId) {
			return receipts.filter((r) => r.userId === userId && r.runId === runId);
		},
		async saveNote(note) {
			notes.set(key(note.userId, note.id), structuredClone(note));
		},
		async getNote(userId, id) {
			return notes.get(key(userId, id)) ?? null;
		},
		async listNotes(userId) {
			return [...notes.values()].filter((n) => n.userId === userId);
		},
		async removeNote(userId, id) {
			notes.delete(key(userId, id));
		},
		async getConversation(userId, conversationId) {
			return conversations.get(key(userId, conversationId)) ?? { offers: [], declinedOffers: [] };
		},
		async saveConversation(userId, conversationId, state) {
			conversations.set(key(userId, conversationId), { offers: [], declinedOffers: [...state.declinedOffers] });
		},
	};
}

export function createMemoryStore(): Store {
	return createStoreAdapter(createMemoryStoreBackend());
}
