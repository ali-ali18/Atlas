import type { UserEventRecord, UserEventStore } from "../user-events.js";

/**
 * Log de eventos em memória com a mesma semântica do Postgres (contador por usuário, `seq` sem buracos,
 * poda que não mexe no contador). Para testes de API, worker e do próprio db.
 */
export function createMemoryUserEventStore(now: () => number = Date.now): UserEventStore & {
	events: Map<string, Array<UserEventRecord & { at: number }>>;
	counters: Map<string, number>;
	/** Simula falha do banco na próxima chamada de publish. */
	failNextPublish: () => void;
} {
	const events = new Map<string, Array<UserEventRecord & { at: number }>>();
	const counters = new Map<string, number>();
	let failPublish = false;
	return {
		events,
		counters,
		failNextPublish: () => {
			failPublish = true;
		},
		async listAfter(userId, afterSeq, limit) {
			return (events.get(userId) ?? [])
				.filter((event) => event.seq > afterSeq)
				.sort((a, b) => a.seq - b.seq)
				.slice(0, limit)
				.map(({ at: _at, ...event }) => event);
		},
		async head(userId) {
			return counters.get(userId) ?? 0;
		},
		async publish(userId, type, payload) {
			if (failPublish) {
				failPublish = false;
				throw new Error("db down");
			}
			const seq = (counters.get(userId) ?? 0) + 1;
			counters.set(userId, seq);
			const at = now();
			const list = events.get(userId) ?? [];
			list.push({ seq, type, payload, createdAt: new Date(at).toISOString(), at });
			events.set(userId, list);
			return seq;
		},
		async prune(before) {
			let removed = 0;
			for (const [userId, list] of events) {
				const kept = list.filter((event) => event.at >= before.getTime());
				removed += list.length - kept.length;
				events.set(userId, kept);
			}
			return removed;
		},
	};
}
