import assert from "node:assert/strict";
import { test } from "node:test";
import { createActiveTracker, drainAgentWork } from "./shutdown.js";
import { startLeaseGuards, WorkerShuttingDownError } from "./lease-guards.js";
import { classifyRunError } from "@workspace/agent-runtime";

const quiet = () => undefined;
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("sem run ativo: só pausa e sai", async () => {
	const tracker = createActiveTracker();
	let paused = 0;
	let checkpoints = 0;
	const outcome = await drainAgentWork({
		pause: async () => void (paused += 1),
		activeCount: tracker.count,
		whenIdle: tracker.whenIdle,
		requestCheckpoint: () => void (checkpoints += 1),
		log: quiet,
	});
	assert.equal(outcome, "idle");
	assert.equal(paused, 1);
	assert.equal(checkpoints, 0);
});

test("run que termina dentro da janela não é abortado", async () => {
	const tracker = createActiveTracker();
	let checkpoints = 0;
	const job = tracker.track(() => tick(30));
	const outcome = await drainAgentWork({
		pause: async () => undefined,
		activeCount: tracker.count,
		whenIdle: tracker.whenIdle,
		requestCheckpoint: () => void (checkpoints += 1),
		softGraceMs: 500,
		hardGraceMs: 500,
		log: quiet,
	});
	await job;
	assert.equal(outcome, "finished-in-grace");
	assert.equal(checkpoints, 0);
});

test("run que não termina: pede checkpoint e o lease é liberado antes do hard timeout", async () => {
	const tracker = createActiveTracker();
	const shutdown = new AbortController();
	let released = false;
	const job = tracker.track(async () => {
		// Fake do processor: ao receber o sinal, "grava o checkpoint" e solta o lease.
		await new Promise<void>((resolve) => shutdown.signal.addEventListener("abort", () => resolve()));
		released = true;
	});
	const outcome = await drainAgentWork({
		pause: async () => undefined,
		activeCount: tracker.count,
		whenIdle: tracker.whenIdle,
		requestCheckpoint: () => shutdown.abort(),
		softGraceMs: 40,
		hardGraceMs: 500,
		log: quiet,
	});
	await job;
	assert.equal(outcome, "aborted-and-released");
	assert.equal(released, true);
});

test("run teimoso: devolve timed-out em vez de travar o shutdown", async () => {
	const tracker = createActiveTracker();
	let stop!: () => void;
	const job = tracker.track(() => new Promise<void>((resolve) => (stop = resolve)));
	const outcome = await drainAgentWork({
		pause: async () => undefined,
		activeCount: tracker.count,
		whenIdle: tracker.whenIdle,
		requestCheckpoint: () => undefined,
		softGraceMs: 20,
		hardGraceMs: 20,
		log: quiet,
	});
	assert.equal(outcome, "timed-out");
	stop();
	await job;
});

test("shutdownSignal aborta o guard com erro que o processor trata como lease perdido (checkpoint)", () => {
	const shutdown = new AbortController();
	const guards = startLeaseGuards({
		runId: "r1",
		renew: async () => true,
		isCancelRequested: async () => false,
		shutdownSignal: shutdown.signal,
	});
	assert.equal(guards.aborter.signal.aborted, false);
	shutdown.abort();
	assert.equal(guards.aborter.signal.aborted, true);
	const reason = guards.aborter.signal.reason;
	assert.ok(reason instanceof WorkerShuttingDownError);
	assert.equal(classifyRunError(reason), "lease_lost");
	guards.stop();
});
