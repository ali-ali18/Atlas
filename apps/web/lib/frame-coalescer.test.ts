import assert from "node:assert/strict";
import test from "node:test";
import { createFrameCoalescer } from "./frame-coalescer";

function fakeFrames() {
	const queue = new Map<number, () => void>();
	let next = 1;
	return {
		schedule: (callback: () => void) => {
			queue.set(next, callback);
			return next++;
		},
		unschedule: (handle: number) => void queue.delete(handle),
		flush: () => {
			const callbacks = [...queue.values()];
			queue.clear();
			for (const callback of callbacks) callback();
		},
		pending: () => queue.size,
	};
}

test("vários pedidos no mesmo quadro rodam uma vez só", () => {
	const frames = fakeFrames();
	let runs = 0;
	const follow = createFrameCoalescer(() => (runs += 1), frames.schedule, frames.unschedule);
	for (let token = 0; token < 50; token += 1) follow.request();
	assert.equal(frames.pending(), 1);
	frames.flush();
	assert.equal(runs, 1);
	follow.request();
	frames.flush();
	assert.equal(runs, 2);
});

test("cancelar descarta o quadro agendado", () => {
	const frames = fakeFrames();
	let runs = 0;
	const follow = createFrameCoalescer(() => (runs += 1), frames.schedule, frames.unschedule);
	follow.request();
	follow.cancel();
	frames.flush();
	assert.equal(runs, 0);
	follow.request();
	assert.equal(frames.pending(), 1);
});
