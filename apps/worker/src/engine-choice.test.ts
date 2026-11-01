/**
 * Escolha do motor do run (ADR 0002, F2).
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/engine-choice.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { pickRunEngine } from "./engine-choice.js";

function setup(over: { policyJson?: unknown; budgetJson?: unknown; origin?: string; isGroupRun?: boolean; hasCheckpoint?: boolean; text?: string; forceV1?: boolean } = {}) {
	const recorded: Array<{ engine: string; profile: string }> = [];
	const choose = () =>
		pickRunEngine({
			run: { origin: over.origin ?? "chat", budgetJson: over.budgetJson ?? null },
			policyJson: over.policyJson ?? null,
			isGroupRun: over.isGroupRun ?? false,
			hasCheckpoint: over.hasCheckpoint ?? false,
			lastUserText: over.text ?? "Bom dia",
			forceV1: over.forceV1,
			record: async (choice) => {
				recorded.push(choice);
				return choice.engine;
			},
		});
	return { recorded, choose };
}

test("bot sem policy roda no v1 e não grava nada", async () => {
	const { recorded, choose } = setup();
	assert.deepEqual(await choose(), { engine: "v1", profile: "chat" });
	assert.deepEqual(recorded, []);
});

test("policy v2 roda no v2, escolhe o perfil pelo pedido e grava a escolha no run", async () => {
	const chat = setup({ policyJson: { engine: "v2" }, text: "Bom dia" });
	assert.equal((await chat.choose()).profile, "chat");
	assert.deepEqual(chat.recorded, [{ engine: "v2", profile: "chat" }]);

	const long = setup({ policyJson: { engine: "v2", longWorkBudgetUsd: 1, longWorkMinutes: 30 }, text: "Faça uma pesquisa de mercado completa e monte um relatório" });
	assert.deepEqual(await long.choose(), { engine: "v2", profile: "long_work", longWorkBudgetUsd: 1, longWorkMinutes: 30 });
	assert.deepEqual(long.recorded, [{ engine: "v2", profile: "long_work" }]);
});

test("a retomada respeita o motor e o perfil gravados, mesmo com a policy do bot trocada", async () => {
	const resumeV1 = setup({ policyJson: { engine: "v2" }, budgetJson: { engine: "v1" }, hasCheckpoint: true });
	assert.equal((await resumeV1.choose()).engine, "v1");
	const resumeV2 = setup({ policyJson: null, budgetJson: { engine: "v2", engineProfile: "long_work" }, hasCheckpoint: true });
	assert.deepEqual(await resumeV2.choose(), { engine: "v2", profile: "long_work", longWorkBudgetUsd: 0.5, longWorkMinutes: 20 });
	// Já gravado: não grava de novo.
	assert.deepEqual(resumeV2.recorded, []);
});

test("run com checkpoint e sem motor gravado nasceu no v1 e continua nele", async () => {
	const { choose, recorded } = setup({ policyJson: { engine: "v2" }, hasCheckpoint: true });
	assert.equal((await choose()).engine, "v1");
	assert.deepEqual(recorded, []);
});

test("rotina, webhook, proativo, subagente e grupo continuam no v1 mesmo com policy v2", async () => {
	for (const origin of ["routine", "webhook", "proactive", "email", "bot", "subagent"]) {
		assert.equal((await setup({ policyJson: { engine: "v2" }, origin }).choose()).engine, "v1", origin);
	}
	assert.equal((await setup({ policyJson: { engine: "v2" }, isGroupRun: true }).choose()).engine, "v1");
});

test("modo proativo, alerta e evento de configuração do bot forçam o v1 (o v2 não tem essas tools)", async () => {
	const { choose, recorded } = setup({ policyJson: { engine: "v2" }, forceV1: true });
	assert.equal((await choose()).engine, "v1");
	assert.deepEqual(recorded, []);
	// Motor já gravado vence o força-v1 (retomada).
	assert.equal((await setup({ policyJson: null, budgetJson: { engine: "v2" }, hasCheckpoint: true, forceV1: true }).choose()).engine, "v2");
});

test("se a escolha não puder ser gravada, o run roda no v1 (a retomada não troca de motor)", async () => {
	const base = { run: { origin: "chat", budgetJson: null }, policyJson: { engine: "v2" }, isGroupRun: false, hasCheckpoint: false, lastUserText: "oi" };
	const failing = await pickRunEngine({
		...base,
		record: async () => {
			throw new Error("db fora");
		},
	});
	assert.equal(failing.engine, "v1");
	// Outra execução já tinha gravado v1 no mesmo run: vale o gravado.
	const lost = await pickRunEngine({ ...base, record: async () => "v1" });
	assert.equal(lost.engine, "v1");
	const unknownRun = await pickRunEngine({ ...base, record: async () => null });
	assert.equal(unknownRun.engine, "v1");
});
