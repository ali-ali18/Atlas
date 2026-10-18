const ACTIVE = new Set([
	"queued",
	"running",
	"retrying",
	"waiting_external",
]);

const QUEUED_STALE_MS = 60_000;
// Five attempts use delays of 15s, 30s, 60s and 120s; allow recovery margin.
const RETRY_STALE_MS = 180_000;

/** Run ativo cujo worker provavelmente morreu (lease vencido ou fila parada). */
export function isDurableRunStale(
	run: {
		status: string;
		leaseUntil: string | null;
		createdAt: string;
		updatedAt: string;
		jobEnqueuedAt: string | null;
	},
	nowMs = Date.now(),
): boolean {
	if (!ACTIVE.has(run.status)) return false;
	if (run.status === "retrying") {
		const start = Date.parse(run.updatedAt);
		return Number.isFinite(start) && nowMs - start > RETRY_STALE_MS;
	}
	if (run.status === "queued") {
		const start = Date.parse(run.jobEnqueuedAt ?? run.updatedAt);
		if (!Number.isFinite(start)) return false;
		return nowMs - start > QUEUED_STALE_MS;
	}
	if (run.leaseUntil) {
		const until = Date.parse(run.leaseUntil);
		return Number.isFinite(until) && until < nowMs;
	}
	const updated = Date.parse(run.updatedAt);
	return Number.isFinite(updated) && nowMs - updated > QUEUED_STALE_MS;
}
