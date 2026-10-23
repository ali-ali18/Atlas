/**
 * Reconciliação de runs presos e reagendamento das rotinas rodam SÓ no worker: a API repetia o mesmo
 * trabalho (consultas em dobro a cada 15 s e um rehydrate a mais por boot). Os dois `index.ts` têm efeitos
 * ao importar, então o teste confere o código-fonte.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const api = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../../worker/src/index.ts", import.meta.url), "utf8");

test("API não roda a manutenção que o worker já faz; o worker roda tudo, na cadência de 15 s", () => {
	for (const name of ["recoverStaleRunningRuns", "failStaleRunningRuns", "cancelStaleCancelledRuns", "rehydrateRoutineSchedulers"]) {
		assert.doesNotMatch(api, new RegExp(`\\b${name}\\(`), `API ainda chama ${name}`);
		assert.match(worker, new RegExp(`\\b${name}\\(`), `worker deveria chamar ${name}`);
	}
	assert.match(worker, /const STALE_RUN_RECONCILE_MS = 15_000;/);
	// O que é só da API continua nela: runs `queued` sem job e decisões dos orquestradores.
	assert.match(api, /reconcileQueuedAgentRuns\(agentRunQueue\)/);
	assert.match(api, /applyQueuedBotDecisions\(/);
});
