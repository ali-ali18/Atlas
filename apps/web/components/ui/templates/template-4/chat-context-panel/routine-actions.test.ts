import assert from "node:assert/strict";
import test from "node:test";
import {
	copyFieldText,
	isRoutineRunning,
	runOptimisticToggle,
	runTest,
} from "./routine-actions";

test("pausar é otimista e mantém quando o servidor aceita", async () => {
	const applied: boolean[] = [];
	const result = await runOptimisticToggle({
		current: true,
		apply: (v) => applied.push(v),
		request: async () => null,
	});
	assert.deepEqual(applied, [false]);
	assert.deepEqual(result, { ok: true, error: null });
});

test("pausar faz rollback e sinaliza erro quando o servidor recusa", async () => {
	const applied: boolean[] = [];
	const result = await runOptimisticToggle({
		current: true,
		apply: (v) => applied.push(v),
		request: async () => "falhou",
	});
	assert.deepEqual(applied, [false, true]);
	assert.deepEqual(result, { ok: false, error: "pause" });
});

test("retomar com exceção faz rollback e erro resume", async () => {
	const applied: boolean[] = [];
	const result = await runOptimisticToggle({
		current: false,
		apply: (v) => applied.push(v),
		request: async () => {
			throw new Error("rede");
		},
	});
	assert.deepEqual(applied, [true, false]);
	assert.equal(result.error, "resume");
});

test("Testar fica em execução: pendente, pai rodando ou última run ativa", () => {
	const idle = { pending: false, running: false };
	assert.equal(isRoutineRunning({ ...idle, pending: true, runs: [] }), true);
	assert.equal(isRoutineRunning({ ...idle, running: true, runs: [] }), true);
	assert.equal(isRoutineRunning({ ...idle, runs: [{ status: "running" }] }), true);
	assert.equal(isRoutineRunning({ ...idle, runs: [{ status: "queued" }] }), true);
	assert.equal(isRoutineRunning({ ...idle, runs: [{ status: "succeeded" }] }), false);
	assert.equal(isRoutineRunning({ ...idle, runs: [] }), false);
});

test("runTest: false ou exceção = falha", async () => {
	assert.equal(await runTest(async () => true), true);
	assert.equal(await runTest(() => undefined), true);
	assert.equal(await runTest(async () => false), false);
	assert.equal(
		await runTest(async () => {
			throw new Error("x");
		}),
		false,
	);
});

test("copyFieldText copia e reporta falha", async () => {
	const copied: string[] = [];
	assert.equal(await copyFieldText("abc", async (v) => void copied.push(v)), true);
	assert.deepEqual(copied, ["abc"]);
	assert.equal(await copyFieldText("abc", undefined), false);
	assert.equal(
		await copyFieldText("abc", async () => {
			throw new Error("negado");
		}),
		false,
	);
});

import { buildRoutineMenu } from "./routine-actions";

test("menu da rotina: Pausar/Editar/Testar/Histórico e Excluir vermelho após divisor", () => {
	const items = buildRoutineMenu({ active: true, persisted: true, kind: "other", running: false });
	assert.deepEqual(items.map((i) => i.label), ["Pausar", "Editar", "Testar", "Histórico", "Excluir"]);
	const del = items.at(-1)!;
	assert.equal(del.destructive, true);
	assert.equal(del.separatorBefore, true);
});

test("menu: Retomar quando pausada, Em execução… desabilita Testar", () => {
	const items = buildRoutineMenu({ active: false, persisted: true, kind: "other", running: true });
	assert.equal(items[0]?.label, "Retomar");
	assert.equal(items[2]?.label, "Em execução…");
	assert.equal(items[2]?.disabled, true);
});

test("menu: Webhook… e Gatilho do GitHub… só para o tipo certo; rascunho só edita", () => {
	assert.ok(buildRoutineMenu({ active: true, persisted: true, kind: "webhook", running: false }).some((i) => i.label === "Webhook…"));
	assert.ok(buildRoutineMenu({ active: true, persisted: true, kind: "github", running: false }).some((i) => i.label === "Gatilho do GitHub…"));
	const draft = buildRoutineMenu({ active: true, persisted: false, kind: "other", running: false });
	assert.deepEqual(draft.filter((i) => !i.disabled).map((i) => i.id), ["edit"]);
});
