import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextQueueDelay, resetDevQueueState, retryQueuedDevSessionsOnce, type DevQueueStore } from "./queue.js";
import type { DevSandboxProvider } from "./provider.js";

const denied = { status: "queued" as const, denied: { admit: false as const, reason: "max_concurrent" as const, message: "cheio" } };

function setup(sessions: Array<{ id: string; userId: string; tier: "small" }>, responses: Array<"queued" | "running">) {
	const queue = [...sessions];
	const calls: string[] = [];
	const provider = {
		ensureRunning: vi.fn(async (input: { sessionId: string }) => {
			calls.push(input.sessionId);
			const next = responses.shift() ?? "queued";
			return next === "running" ? { status: "running" as const, endpoint: { baseUrl: "x", token: "t" }, containerId: `c-${input.sessionId}`, resumed: false } : denied;
		}),
	} as unknown as DevSandboxProvider;
	const marked: string[] = [];
	const store: DevQueueStore = {
		listQueued: async () => queue.filter((s) => !marked.includes(s.id)),
		markRunning: async (id) => {
			marked.push(id);
		},
	};
	return { provider, store, calls, marked };
}

describe("fila de admissão", () => {
	beforeEach(() => resetDevQueueState());

	it("espera dobra até o teto", () => {
		expect([1, 2, 3, 4, 5, 6].map((n) => nextQueueDelay(n, 10_000, 120_000))).toEqual([10_000, 20_000, 40_000, 80_000, 120_000, 120_000]);
	});

	it("sobe a sessão quando abre vaga e avisa", async () => {
		const t = setup([{ id: "a", userId: "u", tier: "small" }], ["running"]);
		const onStarted = vi.fn();
		const result = await retryQueuedDevSessionsOnce({ provider: t.provider, store: t.store, onStarted, log: () => undefined });
		expect(result.started).toEqual(["a"]);
		expect(t.marked).toEqual(["a"]);
		expect(onStarted).toHaveBeenCalledOnce();
	});

	it("sem vaga respeita a espera e não fura a fila", async () => {
		const t = setup([{ id: "a", userId: "u", tier: "small" }, { id: "b", userId: "u", tier: "small" }], ["queued", "running", "running"]);
		let clock = 1_000_000;
		const run = () => retryQueuedDevSessionsOnce({ provider: t.provider, store: t.store, now: () => clock, log: () => undefined });
		expect((await run()).waiting).toEqual(["a"]);
		expect(t.calls).toEqual(["a"]);
		clock += 5_000;
		expect((await run()).skipped).toEqual(["a"]);
		expect(t.calls).toEqual(["a"]);
		clock += 20_000;
		const third = await run();
		expect(third.started).toEqual(["a", "b"]);
	});

	it("erro numa sessão não trava as outras", async () => {
		const t = setup([{ id: "a", userId: "u", tier: "small" }, { id: "b", userId: "u", tier: "small" }], ["running"]);
		(t.provider.ensureRunning as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("docker fora"));
		const result = await retryQueuedDevSessionsOnce({ provider: t.provider, store: t.store, log: () => undefined });
		expect(result.failed).toEqual(["a"]);
		expect(result.started).toEqual(["b"]);
	});
});
