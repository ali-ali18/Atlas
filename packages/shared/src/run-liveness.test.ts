import { describe, expect, it } from "vitest";
import { isDurableRunStale } from "./run-liveness.js";

const base = {
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	jobEnqueuedAt: "2026-01-01T00:00:00.000Z",
	leaseUntil: null as string | null,
};

describe("isDurableRunStale", () => {
	it("respeita o backoff de 120s mesmo em um run antigo", () => {
		const run = { ...base, status: "retrying", updatedAt: "2026-01-01T01:00:00.000Z" };
		expect(isDurableRunStale(run, Date.parse("2026-01-01T01:02:00.000Z"))).toBe(false);
		expect(isDurableRunStale(run, Date.parse("2026-01-01T01:03:01.000Z"))).toBe(true);
	});

	it("não marca a retomada recém-enfileirada como parada", () => {
		expect(isDurableRunStale({ ...base, status: "queued", jobEnqueuedAt: null,
			updatedAt: "2026-01-01T01:00:00.000Z" }, Date.parse("2026-01-01T01:00:10.000Z"))).toBe(false);
	});
	it("ignora runs terminados", () => {
		expect(
			isDurableRunStale(
				{ ...base, status: "completed" },
				Date.parse("2026-01-01T00:10:00.000Z"),
			),
		).toBe(false);
	});

	it("marca queued parado há mais de 60s", () => {
		expect(
			isDurableRunStale(
				{ ...base, status: "queued" },
				Date.parse("2026-01-01T00:01:01.000Z"),
			),
		).toBe(true);
	});

	it("marca running com lease vencido", () => {
		expect(
			isDurableRunStale(
				{
					...base,
					status: "running",
					leaseUntil: "2026-01-01T00:00:30.000Z",
					updatedAt: "2026-01-01T00:00:20.000Z",
				},
				Date.parse("2026-01-01T00:00:45.000Z"),
			),
		).toBe(true);
	});

	it("mantém running com lease válido", () => {
		expect(
			isDurableRunStale(
				{
					...base,
					status: "running",
					leaseUntil: "2026-01-01T00:02:00.000Z",
					updatedAt: "2026-01-01T00:01:00.000Z",
				},
				Date.parse("2026-01-01T00:01:10.000Z"),
			),
		).toBe(false);
	});
});
