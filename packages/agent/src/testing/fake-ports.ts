// Portas em memória para testes do contrato. Só o que o executor usa é funcional
// (Store.journal/receipts, Clock); as demais ficam vazias e quebram alto se alguém as usar.
import type { Clock } from "../ports/clock.js";
import type { JournalEntry, JournalStore, ReceiptStore, StoredReceipt } from "../ports/store.js";
import type { Ports } from "../ports/index.js";

export class FakeJournal implements JournalStore {
	readonly entries: JournalEntry[] = [];
	async append(entry: JournalEntry) {
		this.entries.push(entry);
	}
	/** A entrada mais recente da chave (started → succeeded/failed). */
	async find(userId: string, runId: string, idempotencyKey: string) {
		return [...this.entries].reverse().find((e) => e.userId === userId && e.runId === runId && e.idempotencyKey === idempotencyKey) ?? null;
	}
	async list(userId: string, runId: string) {
		return this.entries.filter((e) => e.userId === userId && e.runId === runId);
	}
}

export class FakeReceipts implements ReceiptStore {
	readonly items: StoredReceipt[] = [];
	async append(receipt: StoredReceipt) {
		this.items.push(receipt);
	}
	async listForRun(userId: string, runId: string) {
		return this.items.filter((r) => r.userId === userId && r.runId === runId);
	}
}

export class FakeClock implements Clock {
	constructor(private current = new Date("2026-11-05T12:00:00Z")) {}
	now() {
		return this.current;
	}
	advance(ms: number) {
		this.current = new Date(this.current.getTime() + ms);
	}
}

export type FakePorts = { ports: Ports; journal: FakeJournal; receipts: FakeReceipts; clock: FakeClock };

export function fakePorts(): FakePorts {
	const journal = new FakeJournal();
	const receipts = new FakeReceipts();
	const clock = new FakeClock();
	const ports = { store: { journal, receipts }, clock } as unknown as Ports;
	return { ports, journal, receipts, clock };
}

import { createHash } from "node:crypto";
export const sha256 = (payload: string): string => createHash("sha256").update(payload).digest("hex");
