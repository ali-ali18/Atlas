import assert from "node:assert/strict";
import { test } from "node:test";
import { executeMemoryTool, type MemoryOps } from "./memory-review.js";

function ops(addResult: { ok: boolean; error?: string } = { ok: true }) {
	const calls: string[] = [];
	const impl = {
		addMemoryEntry: async () => (calls.push("add"), addResult),
		replaceMemoryEntry: async () => (calls.push("replace"), { ok: true }),
		removeMemoryEntry: async () => (calls.push("remove"), { ok: true }),
	};
	return { calls, ops: impl as unknown as MemoryOps };
}

test("W7: add com old_text não cai no remove (nada é apagado)", async () => {
	const { calls, ops: o } = ops();
	const out = await executeMemoryTool(
		JSON.stringify({ action: "add", target: "user", content: "gosta de café", old_text: "gosta de chá" }),
		{ userId: "u1" },
		o,
	);
	assert.deepEqual(calls, ["add"]);
	assert.equal(out.ok, true);
});

test("W7: add duplicado segue ok/skipped e remove explícito continua funcionando", async () => {
	const dup = ops({ ok: false, error: "duplicado" });
	const out = await executeMemoryTool(
		JSON.stringify({ action: "add", target: "user", content: "x" }),
		{ userId: "u1" },
		dup.ops,
	);
	assert.equal(out.ok, true);
	assert.deepEqual(dup.calls, ["add"]);
	const rm = ops();
	await executeMemoryTool(
		JSON.stringify({ action: "remove", target: "user", old_text: "x" }),
		{ userId: "u1" },
		rm.ops,
	);
	assert.deepEqual(rm.calls, ["remove"]);
});

function capture() {
	const targets: string[] = [];
	const impl = {
		addMemoryEntry: async (input: { target: string }) => (targets.push(input.target), { ok: true }),
		replaceMemoryEntry: async (input: { target: string }) => (targets.push(input.target), { ok: true }),
		removeMemoryEntry: async (input: { target: string }) => (targets.push(input.target), { ok: true }),
	};
	return { targets, ops: impl as unknown as MemoryOps };
}

test("isolamento: fato de tarefa/projeto marcado como user é rebaixado para memory (por bot)", async () => {
	const c = capture();
	await executeMemoryTool(
		JSON.stringify({ action: "add", target: "user", content: "6 rotinas criadas: IFIX, dividendos", category: "trabalho" }),
		{ userId: "u1", botId: "bob" },
		c.ops,
	);
	await executeMemoryTool(
		JSON.stringify({ action: "add", target: "user", content: "monitorar deploy no painel" }),
		{ userId: "u1", botId: "bob" },
		c.ops,
	);
	assert.deepEqual(c.targets, ["memory", "memory"]);
});

test("isolamento: perfil pessoal estável continua no store user compartilhado", async () => {
	const c = capture();
	await executeMemoryTool(
		JSON.stringify({ action: "add", target: "user", content: "Chama-se Ali", category: "Identidade" }),
		{ userId: "u1", botId: "bob" },
		c.ops,
	);
	await executeMemoryTool(
		JSON.stringify({ action: "add", target: "user", content: "Fuso America/Sao_Paulo", category: "fuso" }),
		{ userId: "u1", botId: "bob" },
		c.ops,
	);
	await executeMemoryTool(
		JSON.stringify({ action: "add", target: "memory", content: "nota", category: "trabalho" }),
		{ userId: "u1", botId: "bob" },
		c.ops,
	);
	assert.deepEqual(c.targets, ["user", "user", "memory"]);
});
