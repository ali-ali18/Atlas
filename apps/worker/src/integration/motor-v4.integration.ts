/**
 * Integração do motor v4 pelo processador REAL (`processAgentRunJob`): flag ligada para a conta, lease, eventos gravados
 * uma vez, status e entrega. Postgres real e modelo roteirizado (sem rede), como em `motor.integration.ts`.
 * Auditoria F1, T1 / B1. Como rodar: docs/testes-integracao.md (precisa de `ATLAS_TEST_DB_URL`; sem ele os testes são pulados).
 * O registro de capacidades do v4 no worker é vazio hoje, então "estacionar" (aprovação/handoff) ainda não é alcançável
 * pelo caminho real: fica como `todo` até as capacidades entrarem no worker.
 */
import "./env.js";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { integrationSkip } from "./env.js";
import { createApi, createFixture, installFakeLlm, processRun, sendChat, snapshot, type FakeLlm, type ScriptEntry } from "./harness.js";

let llm: FakeLlm | undefined;
const savedEnv = { flag: process.env.ATLAS_ENGINE_V4, accounts: process.env.ATLAS_ENGINE_V4_ACCOUNTS };
const script = (entries: ScriptEntry[]) => (llm = installFakeLlm(entries));
afterEach(() => {
	llm?.restore();
	llm = undefined;
	for (const [key, value] of [["ATLAS_ENGINE_V4", savedEnv.flag], ["ATLAS_ENGINE_V4_ACCOUNTS", savedEnv.accounts]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const count = (events: Array<{ type: string }>, type: string) => events.filter((event) => event.type === type).length;

describe("motor v4 pelo processador real", { skip: integrationSkip }, () => {
	test("flag ligada para a conta: o run sai no v4, termina completed e o fim do stream aparece UMA vez", async () => {
		const fake = script([{ content: "Bom dia! Como posso ajudar?", costUsd: 0.0012 }]);
		const fx = await createFixture();
		process.env.ATLAS_ENGINE_V4 = "1";
		process.env.ATLAS_ENGINE_V4_ACCOUNTS = fx.userId;
		const { app } = await createApi(fx.userId);
		const sent = await sendChat(app, fx, "Bom dia");
		assert.equal(sent.status, 202, JSON.stringify(sent.json));
		const result = await processRun(sent.runId);
		const snap = await snapshot(sent.runId);

		assert.equal(result.status, "completed");
		assert.equal(snap.run.status, "completed");
		assert.equal(snap.budget.engine, "v4", "o motor v4 ficou gravado no run");
		assert.equal(fake.requests.length, 1);
		// B1: o kernel e o processador não fecham o stream duas vezes
		assert.equal(count(snap.events, "done"), 1, "um `done`");
		assert.equal(count(snap.events, "error"), 0);
		assert.equal(count(snap.events, "cancelled"), 0);
		assert.equal(snap.events.at(-1)?.type, "done");
		snap.events.forEach((event, index) => { if (index > 0) assert.ok(event.seq > snap.events[index - 1]!.seq, `seq fora de ordem em ${event.type}`); });
		const answers = snap.messages.filter((m) => m.role === "assistant").map((m) => m.content);
		assert.deepEqual(answers, ["Bom dia! Como posso ajudar?"], "a resposta entra na conversa uma vez");
		assert.equal(snap.run.leaseOwner, null, "o lease foi solto");
	});

	test("conta fora da lista da flag: o run NÃO vai ao v4", async () => {
		script([{ content: "Oi!" }]);
		const fx = await createFixture();
		process.env.ATLAS_ENGINE_V4 = "1";
		process.env.ATLAS_ENGINE_V4_ACCOUNTS = "outra-conta";
		const { app } = await createApi(fx.userId);
		const sent = await sendChat(app, fx, "Oi");
		await processRun(sent.runId);
		const snap = await snapshot(sent.runId);
		assert.notEqual(snap.budget.engine, "v4");
	});

	test("run estacionado vira paused uma vez só (aprovação/handoff)", { todo: "registro de capacidades vazio no worker: não há tool de efeito para estacionar pelo caminho real" }, () => undefined);
});
