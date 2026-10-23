import assert from "node:assert/strict";
import { test } from "node:test";
import { startBotMessageSweeper } from "./bot-messages.js";
import { startGroupSweeper } from "./bot-groups.js";
import { startAdaptiveSweeper } from "./adaptive-sweeper.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("parado (nada em andamento): espera o intervalo longo; com trabalho aberto volta logo", async () => {
	for (const inFlight of [false, true]) {
		let calls = 0;
		const sweeper = startAdaptiveSweeper({ name: "t", step: async () => (calls++, { inFlight }), busyMs: 10, idleMs: 10_000 });
		await sleep(80);
		sweeper.stop();
		if (inFlight) assert.ok(calls >= 3, `com trabalho aberto deveria varrer várias vezes (${calls})`);
		else assert.equal(calls, 1, "parado: uma varredura e depois só a consulta longa");
	}
});

test("aviso (kick) roda na hora mesmo parado; pedido durante um passo roda de novo ao terminar", async () => {
	let calls = 0;
	let release: (() => void) | undefined;
	let kickFromSignal: (() => void) | undefined;
	const sweeper = startAdaptiveSweeper({
		name: "t",
		step: async () => {
			calls += 1;
			if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
			return { inFlight: false };
		},
		busyMs: 60_000,
		idleMs: 60_000,
		triggers: [(kick) => ((kickFromSignal = kick), () => (kickFromSignal = undefined))],
	});
	kickFromSignal!();
	kickFromSignal!();
	await sleep(5);
	assert.equal(calls, 1);
	release!();
	await sleep(5);
	assert.equal(calls, 2);
	sweeper.stop();
	assert.equal(kickFromSignal, undefined, "stop solta os gatilhos");
});

test("passo que lança não derruba o varredor e volta logo", async () => {
	let calls = 0;
	const error = console.error;
	console.error = () => undefined;
	try {
		const sweeper = startAdaptiveSweeper({
			name: "t",
			step: async () => {
				calls += 1;
				throw new Error("db fora");
			},
			busyMs: 10,
			idleMs: 60_000,
		});
		await sleep(60);
		sweeper.stop();
		assert.ok(calls >= 2);
	} finally {
		console.error = error;
	}
});

test("grupos e mensagens entre bots: aviso do Redis acorda; parados não varrem a cada 1,5 s / 3 s", async () => {
	const deps = { enqueueRun: async () => true, envDefaultModel: "m" };
	let groupCalls = 0;
	let messageCalls = 0;
	let groupSignal: (() => void) | undefined;
	let messageSignal: (() => void) | undefined;
	const groups = startGroupSweeper(deps as never, {
		step: async () => (groupCalls++, { routed: 0, started: 0, settled: 0, followUps: 0, busy: 0, inFlight: false }),
		triggers: [(kick) => ((groupSignal = kick), () => undefined)],
	});
	const messages = startBotMessageSweeper(deps as never, {
		step: async () => (messageCalls++, { delivered: 0, busy: 0, replies: 0, settled: 0, needsUser: 0, overdue: 0, inFlight: false }),
		triggers: [(kick) => ((messageSignal = kick), () => undefined)],
	});
	groupSignal!();
	messageSignal!();
	await sleep(20);
	assert.deepEqual([groupCalls, messageCalls], [1, 1]);
	groups.stop();
	messages.stop();
});
