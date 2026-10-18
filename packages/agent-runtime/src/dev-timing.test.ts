import { describe, expect, it } from "vitest";
import type { DevTimingEvent } from "@workspace/shared";
import { createDevTimingTracker } from "./dev-timing.js";

function setup(throttleMs = 5_000) {
	let clock = 1_000_000;
	const events: DevTimingEvent[] = [];
	const tracker = createDevTimingTracker({ emit: (e) => void events.push(e), now: () => clock, throttleMs });
	tracker.setSession("s1", "a/b");
	return { tracker, events, advance: (ms: number) => void (clock += ms) };
}

describe("cronômetro do run de código", () => {
	it("soma modelo, primeiro token, comandos, esperas de polling, arquivos e preparação", async () => {
		const { tracker, events } = setup();
		tracker.model({ ms: 4_000, firstTokenMs: 900 });
		tracker.model({ ms: 6_000, firstTokenMs: 1_100, model: "a/c" });
		tracker.tool("shell", 30_000);
		tracker.tool("shell_output", 20_000);
		tracker.tool("read_file", 150);
		tracker.tool("dev_session_start", 99_000);
		tracker.setup(40_000);
		await tracker.finish();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "dev_timing",
			sessionId: "s1",
			model: "a/c",
			modelMs: 10_000,
			firstTokenMs: 2_000,
			shellMs: 30_000,
			pollWaitMs: 20_000,
			toolsMs: 50_150,
			setupMs: 40_000,
			approvalMs: 0,
			steps: 2,
		});
	});

	it("limita a frequência, mas o final sempre sai com os totais", async () => {
		const { tracker, events, advance } = setup(5_000);
		tracker.model({ ms: 1_000 });
		expect(await tracker.maybeEmit()).toBe(true);
		tracker.model({ ms: 1_000 });
		advance(1_000);
		expect(await tracker.maybeEmit()).toBe(false);
		advance(5_000);
		tracker.tool("shell", 2_000);
		expect(await tracker.maybeEmit()).toBe(true);
		tracker.tool("shell", 1_000);
		expect(await tracker.finish()).toBe(true);
		expect(await tracker.finish()).toBe(false);
		expect(events.map((e) => e.shellMs)).toEqual([0, 2_000, 3_000]);
	});

	it("não emite sem sessão nem sem mudança", async () => {
		const events: DevTimingEvent[] = [];
		const tracker = createDevTimingTracker({ emit: (e) => void events.push(e) });
		tracker.model({ ms: 10 });
		expect(await tracker.finish()).toBe(false);
		expect(events).toHaveLength(0);
	});

	it("registra cartão de aprovação aberto no fim do run", async () => {
		const { tracker, events } = setup();
		tracker.approvalPending();
		await tracker.finish();
		expect(events[0]?.approvalPendingAt).toBe(1_000_000);
	});
});
