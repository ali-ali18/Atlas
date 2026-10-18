import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunControlReader, type RunControlState } from "./run-control.js";

function fakeReader(states: RunControlState[]) {
	let reads = 0;
	let clock = 0;
	const reader = createRunControlReader({
		read: async () => states[Math.min(reads++, states.length - 1)]!,
		freshMs: 500,
		now: () => clock,
	});
	return { reader, reads: () => reads, advance: (ms: number) => (clock += ms) };
}

test("L10: cancel e pausa no mesmo passo compartilham UMA leitura", async () => {
	const { reader, reads } = fakeReader([{ cancelRequested: false, pauseRequested: false }]);
	await reader.get();
	await reader.get();
	await reader.get();
	assert.equal(reads(), 1);
});

test("L10: leituras simultâneas dividem a consulta em andamento", async () => {
	const { reader, reads } = fakeReader([{ cancelRequested: false, pauseRequested: false }]);
	await Promise.all([reader.get(), reader.get(), reader.get()]);
	assert.equal(reads(), 1);
});

test("L10: depois da janela lê de novo e vê o cancelamento", async () => {
	const { reader, reads, advance } = fakeReader([
		{ cancelRequested: false, pauseRequested: false },
		{ cancelRequested: true, pauseRequested: false },
	]);
	assert.equal((await reader.get()).cancelRequested, false);
	advance(600);
	assert.equal((await reader.get()).cancelRequested, true);
	assert.equal(reads(), 2);
});

test("L10: falha da leitura não fica em cache", async () => {
	let calls = 0;
	const reader = createRunControlReader({
		read: async () => {
			calls += 1;
			if (calls === 1) throw new Error("db down");
			return { cancelRequested: false, pauseRequested: false };
		},
	});
	await assert.rejects(reader.get(), /db down/);
	assert.equal((await reader.get()).cancelRequested, false);
});
