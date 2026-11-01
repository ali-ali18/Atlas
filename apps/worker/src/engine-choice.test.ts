/**
 * Escolha do motor do run (ADR 0002, F2).
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/engine-choice.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { engineDefaultFromEnv, pickRunEngine } from "./engine-choice.js";
import type { EngineDefault } from "@workspace/shared";

function setup(over: { policyJson?: unknown; budgetJson?: unknown; origin?: string; isGroupRun?: boolean; hasCheckpoint?: boolean; text?: string; forceV1?: boolean; shortRun?: boolean; globalDefault?: EngineDefault } = {}) {
	const recorded: Array<{ engine: string; profile: string }> = [];
	const choose = () =>
		pickRunEngine({
			run: { origin: over.origin ?? "chat", budgetJson: over.budgetJson ?? null },
			policyJson: over.policyJson ?? null,
			isGroupRun: over.isGroupRun ?? false,
			hasCheckpoint: over.hasCheckpoint ?? false,
			lastUserText: over.text ?? "Bom dia",
			forceV1: over.forceV1,
			shortRun: over.shortRun,
			globalDefault: over.globalDefault,
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
	assert.deepEqual(await long.choose(), { engine: "v2", profile: "long_work", longWorkBudgetUsd: 1, longWorkMinutes: 30, helperModel: null, helperMaxParallel: 4 });
	assert.deepEqual(long.recorded, [{ engine: "v2", profile: "long_work" }]);
});

test("ajudantes: modelo barato e paralelo vêm da policy do bot (padrão: mesmo modelo, 4 juntos)", async () => {
	const custom = setup({ policyJson: { engine: "v2", helperModel: "google/barato", helperMaxParallel: 2 }, text: "Faça uma pesquisa de mercado completa e monte um relatório" });
	const choice = await custom.choose();
	assert.equal(choice.helperModel, "google/barato");
	assert.equal(choice.helperMaxParallel, 2);
	const bad = setup({ policyJson: { engine: "v2", helperModel: "modelo inválido!", helperMaxParallel: 99 } });
	const fallback = await bad.choose();
	assert.equal(fallback.helperModel, null);
	assert.equal(fallback.helperMaxParallel, 8);
});

test("a retomada respeita o motor e o perfil gravados, mesmo com a policy do bot trocada", async () => {
	const resumeV1 = setup({ policyJson: { engine: "v2" }, budgetJson: { engine: "v1" }, hasCheckpoint: true });
	assert.equal((await resumeV1.choose()).engine, "v1");
	const resumeV2 = setup({ policyJson: null, budgetJson: { engine: "v2", engineProfile: "long_work" }, hasCheckpoint: true });
	assert.deepEqual(await resumeV2.choose(), { engine: "v2", profile: "long_work", longWorkBudgetUsd: 0.5, longWorkMinutes: 20, helperModel: null, helperMaxParallel: 4 });
	// Já gravado: não grava de novo.
	assert.deepEqual(resumeV2.recorded, []);
});

test("run com checkpoint e sem motor gravado nasceu no v1 e continua nele", async () => {
	const { choose, recorded } = setup({ policyJson: { engine: "v2" }, hasCheckpoint: true });
	assert.equal((await choose()).engine, "v1");
	assert.deepEqual(recorded, []);
});

test("escopo chat (padrão): rotina, webhook, proativo, subagente, bot→bot e grupo continuam no v1 mesmo com policy v2", async () => {
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

// ---- escopo "all" e padrão global ----

const wide = { engine: "v2", engineScope: "all" };

test("escopo all: rotina, grupo, bot→bot e proativo saem no v2 e gravam a escolha; o chat também", async () => {
	for (const [name, over] of [
		["rotina", { origin: "routine" }],
		["grupo", { origin: "chat", isGroupRun: true }],
		["bot→bot", { origin: "bot" }],
		["proativo", { origin: "proactive" }],
		["chat", { origin: "chat" }],
	] as const) {
		const { choose, recorded } = setup({ policyJson: wide, ...over });
		assert.equal((await choose()).engine, "v2", name);
		assert.deepEqual(recorded, [{ engine: "v2", profile: "chat" }], name);
	}
});

test("escopo all não leva subagente, webhook nem e-mail ao v2", async () => {
	for (const origin of ["subagent", "webhook", "email"]) {
		const { choose, recorded } = setup({ policyJson: wide, origin });
		assert.equal((await choose()).engine, "v1", origin);
		assert.deepEqual(recorded, [], origin);
	}
});

test("escopo chat explícito segura rotina, grupo e bot→bot no v1", async () => {
	for (const over of [{ origin: "routine" }, { origin: "bot" }, { origin: "chat", isGroupRun: true }]) {
		assert.equal((await setup({ policyJson: { engine: "v2", engineScope: "chat" }, ...over }).choose()).engine, "v1");
	}
});

test("rotina no v2: relatório vira long_work, tarefa curta fica em chat", async () => {
	const report = setup({ policyJson: wide, origin: "routine", text: "Levante os pedidos em aberto e monte um relatório comparativo com preços" });
	assert.equal((await report.choose()).profile, "long_work");
	const simple = setup({ policyJson: wide, origin: "routine", text: "Me lembre de beber água" });
	assert.equal((await simple.choose()).profile, "chat");
});

test("forceV1 (gancho para recurso do v1 que o v2 não cobre) vence o escopo all e o padrão global", async () => {
	const { choose, recorded } = setup({ policyJson: wide, origin: "routine", forceV1: true, globalDefault: "all" });
	assert.equal((await choose()).engine, "v1");
	assert.deepEqual(recorded, []);
});

test("padrão global off (ou ausente): bot sem escolha não muda em nenhuma origem", async () => {
	for (const globalDefault of [undefined, "off"] as const) {
		for (const over of [{ origin: "chat" }, { origin: "routine" }, { origin: "bot" }, { origin: "chat", isGroupRun: true }]) {
			const { choose, recorded } = setup({ policyJson: { planMode: true }, globalDefault, ...over });
			assert.equal((await choose()).engine, "v1");
			assert.deepEqual(recorded, []);
		}
	}
});

test("padrão global chat/all vale para bot sem escolha explícita", async () => {
	assert.equal((await setup({ globalDefault: "chat", origin: "chat" }).choose()).engine, "v2");
	assert.equal((await setup({ globalDefault: "chat", origin: "routine" }).choose()).engine, "v1");
	for (const over of [{ origin: "chat" }, { origin: "routine" }, { origin: "bot" }, { origin: "chat", isGroupRun: true }]) {
		assert.equal((await setup({ policyJson: { planMode: true }, globalDefault: "all", ...over }).choose()).engine, "v2");
	}
	assert.equal((await setup({ globalDefault: "all", origin: "subagent" }).choose()).engine, "v1");
});

test("bot com engine v1 explícito nunca vai ao v2, nem com o padrão global all", async () => {
	for (const over of [{ origin: "chat" }, { origin: "routine" }, { origin: "bot" }, { origin: "chat", isGroupRun: true }]) {
		const { choose, recorded } = setup({ policyJson: { engine: "v1", engineScope: "all" }, globalDefault: "all", ...over });
		assert.equal((await choose()).engine, "v1");
		assert.deepEqual(recorded, []);
	}
});

test("retomada: o motor gravado vence o padrão global nos dois sentidos", async () => {
	assert.equal((await setup({ globalDefault: "all", budgetJson: { engine: "v1" }, hasCheckpoint: true }).choose()).engine, "v1");
	assert.equal((await setup({ globalDefault: "off", budgetJson: { engine: "v2", engineProfile: "chat" }, hasCheckpoint: true, origin: "routine" }).choose()).engine, "v2");
});

test("engineDefaultFromEnv lê ATLAS_ENGINE_V2_DEFAULT; ausente ou inválido é off", () => {
	assert.equal(engineDefaultFromEnv({}), "off");
	assert.equal(engineDefaultFromEnv({ ATLAS_ENGINE_V2_DEFAULT: "chat" }), "chat");
	assert.equal(engineDefaultFromEnv({ ATLAS_ENGINE_V2_DEFAULT: "ALL" }), "all");
	assert.equal(engineDefaultFromEnv({ ATLAS_ENGINE_V2_DEFAULT: "sim" }), "off");
});

test("alerta, brief, proativo e config do bot (shortRun) saem no v2 sempre no perfil chat, mesmo com pedido de relatório ou long_work forçado", async () => {
	const report = "Levante os pedidos em aberto e monte um relatório comparativo com preços";
	for (const [name, over] of [
		["alerta/brief (rotina)", { origin: "routine" }],
		["proativo", { origin: "proactive" }],
		["config do bot (chat)", { origin: "chat" }],
	] as const) {
		const auto = setup({ policyJson: wide, text: report, shortRun: true, ...over });
		assert.deepEqual(await auto.choose(), { engine: "v2", profile: "chat", longWorkBudgetUsd: 0.5, longWorkMinutes: 20, helperModel: null, helperMaxParallel: 4 }, name);
		assert.deepEqual(auto.recorded, [{ engine: "v2", profile: "chat" }], name);
		const forced = setup({ policyJson: { ...wide, workProfile: "long_work" }, text: report, shortRun: true, ...over });
		assert.equal((await forced.choose()).profile, "chat", `${name} com long_work forçado`);
	}
	// Sem shortRun o pedido de relatório continua virando trabalho longo.
	assert.equal((await setup({ policyJson: wide, origin: "routine", text: report }).choose()).profile, "long_work");
});

test("alerta, brief e proativo seguem no v1 sem o escopo all (padrão sem chave continua v1)", async () => {
	for (const over of [{ origin: "routine" }, { origin: "proactive" }]) {
		for (const policyJson of [null, { engine: "v2" }, { engine: "v2", engineScope: "chat" }]) {
			const { choose, recorded } = setup({ policyJson, shortRun: true, ...over });
			assert.equal((await choose()).engine, "v1");
			assert.deepEqual(recorded, []);
		}
	}
});
