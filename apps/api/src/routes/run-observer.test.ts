import assert from "node:assert/strict";
import { test } from "node:test";
import { closesRunStream, createRunObserver, pausedClosingEvent } from "./run-observer.js";

test("cancelar leitura encerra o observador sem novos polls", async () => {
	let polls = 0;
	let finished!: () => void;
	const completion = new Promise<void>((resolve) => { finished = resolve; });
	const stream = createRunObserver(new AbortController().signal, async (observer) => {
		while (!observer.stopped()) { polls++; observer.send(new Uint8Array([1])); await observer.wait(60_000); }
		finished();
	});
	const reader = stream.getReader();
	await reader.read();
	await reader.cancel();
	await completion;
	assert.equal(polls, 1);
});

test("abort encerra e fecha SSE mesmo durante espera", async () => {
	const abort = new AbortController();
	const stream = createRunObserver(abort.signal, async (observer) => { await observer.wait(60_000); });
	const reader = stream.getReader();
	abort.abort();
	assert.equal((await reader.read()).done, true);
});

test("pausa e estados terminais encerram stream; espera externa permanece", () => {
	for (const status of ["paused", "completed", "failed", "cancelled", "budget_exhausted"]) assert.equal(closesRunStream(status), true);
	for (const status of ["running", "waiting_user", "waiting_external"]) assert.equal(closesRunStream(status), false);
});

test("run pausado fecha o stream com evento paused explícito (sem id)", () => {
	assert.deepEqual(pausedClosingEvent("paused"), { type: "paused", reason: "Aguardando ação do usuário" });
	for (const status of ["running", "completed", "failed", "cancelled", "waiting_user"]) {
		assert.equal(pausedClosingEvent(status), null);
	}
});
