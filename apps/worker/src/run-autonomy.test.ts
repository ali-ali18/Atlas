import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadedAutonomy } from "@workspace/db";
import { resolveRunAutonomy, type RunAutonomyDeps } from "./run-autonomy.js";

const NOW = new Date("2026-09-29T12:00:00.000Z");

function loaded(overrides: Partial<LoadedAutonomy> = {}): LoadedAutonomy {
	return {
		policy: { level: "balanced", exceptions: [] },
		source: "default",
		expired: [],
		applied: [],
		botName: "Taldo",
		...overrides,
	};
}

function deps(result: LoadedAutonomy | Error) {
	const calls = { load: [] as unknown[], notify: [] as string[] };
	const d: RunAutonomyDeps = {
		load: async (input) => {
			calls.load.push(input);
			if (result instanceof Error) throw result;
			return result;
		},
		notify: async (_conversationId, text) => {
			calls.notify.push(text);
		},
	};
	return { d, calls };
}

const expiry = {
	scope: "bot" as const,
	from: "autonomous" as const,
	to: "balanced" as const,
	next: { exceptions: [] },
	previous: { level: "autonomous" as const, exceptions: [] },
};

test("vencimento: run de chat avisa UMA vez no chat", async () => {
	const { d, calls } = deps(loaded({ applied: [expiry] }));
	const policy = await resolveRunAutonomy(
		{ userId: "u", botId: "b", conversationId: "c", origin: "chat", now: NOW },
		d,
	);
	assert.equal(policy.level, "balanced");
	assert.deepEqual(calls.notify, ["A autonomia do Taldo voltou para Equilibrado."]);
});

test("nada foi gravado por este run (outro run já avisou): sem aviso", async () => {
	const { d, calls } = deps(loaded({ expired: [expiry], applied: [] }));
	await resolveRunAutonomy({ userId: "u", botId: "b", conversationId: "c", origin: "chat", now: NOW }, d);
	assert.deepEqual(calls.notify, []);
});

test("rotina e webhook só resolvem: não gravam o fallback nem avisam", async () => {
	for (const origin of ["routine", "webhook"]) {
		const { d, calls } = deps(loaded({ applied: [expiry] }));
		await resolveRunAutonomy({ userId: "u", botId: "b", conversationId: "c", origin, now: NOW }, d);
		assert.deepEqual(calls.notify, [], origin);
		assert.deepEqual((calls.load[0] as { applyExpiry: boolean }).applyExpiry, false, origin);
	}
});

test("falha ao ler cai em Equilibrado (não derruba o run)", async () => {
	const { d } = deps(new Error("db fora"));
	const original = console.error;
	console.error = () => undefined;
	try {
		const policy = await resolveRunAutonomy({ userId: "u", conversationId: "c", origin: "chat", now: NOW }, d);
		assert.deepEqual(policy, { level: "balanced", exceptions: [] });
	} finally {
		console.error = original;
	}
});
