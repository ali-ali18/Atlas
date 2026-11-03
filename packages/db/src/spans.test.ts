/**
 * Tracing (PR3c): `recordSpan` escreve só na linha do passo do dono do run e nunca lança.
 * Prisma stubado (sem banco). Runner: node:test em packages/db.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const { prisma } = await import("./client.js");
const { recordSpan } = await import("./spans.js");

type Row = { runId: string; decisionIndex: number; subIndex: number; ownerId: string } & Record<string, unknown>;
const original = Reflect.get(prisma.agentStep, "updateMany");
afterEach(() => Object.assign(prisma.agentStep, { updateMany: original }));

/** updateMany em memória: respeita o filtro por dono do run (`run: { userId }`). */
function installRows(rows: Row[]) {
	Object.assign(prisma.agentStep, {
		updateMany: async (args: { where: { runId: string; decisionIndex: number; subIndex: number; run: { userId: string } }; data: Record<string, unknown> }) => {
			const hit = rows.filter((row) => row.runId === args.where.runId && row.decisionIndex === args.where.decisionIndex && row.subIndex === args.where.subIndex && row.ownerId === args.where.run.userId);
			for (const row of hit) for (const [key, value] of Object.entries(args.data)) if (value !== undefined) row[key] = value;
			return { count: hit.length };
		},
	});
}

const base = { runId: "run-a", decisionIndex: 1, subIndex: 0, kind: "model" as const };

test("dono grava o span do modelo na linha do passo", async () => {
	const rows: Row[] = [{ runId: "run-a", decisionIndex: 1, subIndex: 0, ownerId: "user-a" }];
	installRows(rows);
	const ok = await recordSpan({ ...base, userId: "user-a", provider: "openrouter", model: "a/b", cachedTokens: 60.4, outputTokens: 12, ttftMs: 410, finishReason: "stop" });
	assert.equal(ok, true);
	assert.deepEqual(rows[0], { runId: "run-a", decisionIndex: 1, subIndex: 0, ownerId: "user-a", kind: "model", provider: "openrouter", model: "a/b", cachedTokens: 60, outputTokens: 12, ttftMs: 410, finishReason: "stop" });
});

test("tool grava a decisão da política e não apaga o que já havia", async () => {
	const rows: Row[] = [{ runId: "run-a", decisionIndex: 1, subIndex: 1, ownerId: "user-a", model: "antes" }];
	installRows(rows);
	assert.equal(await recordSpan({ userId: "user-a", runId: "run-a", decisionIndex: 1, subIndex: 1, kind: "tool", policyDecision: "blocked" }), true);
	assert.equal(rows[0]!.policyDecision, "blocked");
	assert.equal(rows[0]!.model, "antes");
});

test("escopo: outro usuário, legado default e dono vazio não escrevem nada", async () => {
	const rows: Row[] = [{ runId: "run-a", decisionIndex: 1, subIndex: 0, ownerId: "user-a" }];
	installRows(rows);
	for (const userId of ["user-b", "default", "  ", ""]) assert.equal(await recordSpan({ ...base, userId, provider: "x" }), false, userId);
	assert.equal(rows[0]!.provider, undefined);
});

test("passo inexistente devolve false; valor negativo ou NaN é descartado", async () => {
	const rows: Row[] = [{ runId: "run-a", decisionIndex: 1, subIndex: 0, ownerId: "user-a" }];
	installRows(rows);
	assert.equal(await recordSpan({ ...base, userId: "user-a", decisionIndex: 9 }), false);
	await recordSpan({ ...base, userId: "user-a", ttftMs: -5, cachedTokens: Number.NaN, outputTokens: 3 });
	assert.equal(rows[0]!.ttftMs, undefined);
	assert.equal(rows[0]!.cachedTokens, undefined);
	assert.equal(rows[0]!.outputTokens, 3);
});

test("falha do banco vira log e false, nunca exceção (não derruba o run)", async () => {
	Object.assign(prisma.agentStep, { updateMany: async () => { throw new Error("db fora"); } });
	const warn = console.warn;
	const logged: string[] = [];
	console.warn = (message: string) => { logged.push(String(message)); };
	try {
		assert.equal(await recordSpan({ ...base, userId: "user-a" }), false);
	} finally {
		console.warn = warn;
	}
	assert.equal(logged.length, 1);
	assert.match(logged[0]!, /db fora/);
});
