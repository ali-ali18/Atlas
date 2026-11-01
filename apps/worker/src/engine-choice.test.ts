/**
 * Escolha do motor do run (ADR 0002, F2).
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/engine-choice.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { UNATTENDED_LONG_WORK_COST_FLOOR_USD, engineDefaultFromEnv, longWorkOwnerLimits, pickRunEngine, resolveRunLimits } from "./engine-choice.js";
import type { EngineDefault } from "@workspace/shared";
import { effectiveCostCapUsd } from "./run-config.js";

const HUMAN_CHAT = { origin: "chat", humanTurn: true };

function setup(over: { policyJson?: unknown; budgetJson?: unknown; origin?: string; isGroupRun?: boolean; hasCheckpoint?: boolean; text?: string; forceV1?: boolean; shortRun?: boolean; longerShortRun?: boolean; globalDefault?: EngineDefault } = {}) {
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
			longerShortRun: over.longerShortRun,
			globalDefault: over.globalDefault,
			record: async (choice) => {
				recorded.push(choice);
				return choice.engine;
			},
		});
	return { recorded, choose };
}

test("bot sem policy roda no v2 (padrão novo, sem variável de ambiente) e grava a escolha no run", async () => {
	const { recorded, choose } = setup();
	const choice = await choose();
	assert.equal(choice.engine, "v2");
	assert.equal(choice.profile, "chat");
	assert.deepEqual(recorded, [{ engine: "v2", profile: "chat" }]);
});

test("bot com engine v1 explícito roda no v1 e não grava nada, com ou sem variável", async () => {
	for (const globalDefault of [undefined, "chat", "all", "off"] as const) {
		const { recorded, choose } = setup({ policyJson: { engine: "v1" }, globalDefault });
		assert.deepEqual(await choose(), { engine: "v1", profile: "chat" }, String(globalDefault));
		assert.deepEqual(recorded, []);
	}
});

test("policy v2 roda no v2, escolhe o perfil pelo pedido e grava a escolha no run", async () => {
	const chat = setup({ policyJson: { engine: "v2" }, text: "Bom dia" });
	assert.equal((await chat.choose()).profile, "chat");
	assert.deepEqual(chat.recorded, [{ engine: "v2", profile: "chat" }]);

	const long = setup({ policyJson: { engine: "v2", longWorkBudgetUsd: 1, longWorkMinutes: 30 }, text: "Faça uma pesquisa de mercado completa e monte um relatório" });
	assert.deepEqual(await long.choose(), { engine: "v2", profile: "long_work", longWorkBudgetUsd: 1, longWorkMinutes: 30, longWorkMinutesExplicit: true, helperModel: null, helperMaxParallel: 4 });
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
	assert.deepEqual(await resumeV2.choose(), { engine: "v2", profile: "long_work", longWorkBudgetUsd: undefined, longWorkMinutes: 60, longWorkMinutesExplicit: false, helperModel: null, helperMaxParallel: 4 });
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

test("gancho genérico forceV1: run novo fica no v1 e não grava; motor já gravado vence", async () => {
	const { choose, recorded } = setup({ policyJson: { engine: "v2" }, forceV1: true });
	assert.equal((await choose()).engine, "v1");
	assert.deepEqual(recorded, []);
	// Motor já gravado vence o força-v1 (retomada).
	assert.equal((await setup({ policyJson: null, budgetJson: { engine: "v2" }, hasCheckpoint: true, forceV1: true }).choose()).engine, "v2");
});

// Mudança de comportamento aceita (CHANGELOG [Não lançado]): o worker não força mais o v1 no chat com modo proativo
// ligado nem no evento de configuração do bot. Os dois chegam aqui como origem `chat` com `shortRun` (config) ou sem.
test("chat com modo proativo ligado e evento de configuração do bot no escopo chat vão ao v2 quando o bot tem engine v2", async () => {
	const chatProativo = setup({ policyJson: { engine: "v2", engineScope: "chat" }, origin: "chat", text: "semana que vem tenho prova" });
	assert.equal((await chatProativo.choose()).engine, "v2");
	assert.deepEqual(chatProativo.recorded, [{ engine: "v2", profile: "chat" }]);
	const config = setup({ policyJson: { engine: "v2" }, origin: "chat", shortRun: true, text: "relatório completo de configuração" });
	assert.deepEqual(await config.choose(), { engine: "v2", profile: "chat", longWorkBudgetUsd: undefined, longWorkMinutes: 60, longWorkMinutesExplicit: false, helperModel: null, helperMaxParallel: 4 });
});

test("o padrão ATLAS_ENGINE_V2_DEFAULT=chat leva os mesmos runs ao v2; off (emergência) os devolve ao v1; sem chave é v2", async () => {
	for (const over of [{ origin: "chat" }, { origin: "chat", shortRun: true }]) {
		assert.equal((await setup({ policyJson: null, globalDefault: "chat", ...over }).choose()).engine, "v2");
		assert.equal((await setup({ policyJson: null, ...over }).choose()).engine, "v2");
		const off = setup({ policyJson: null, globalDefault: "off", ...over });
		assert.equal((await off.choose()).engine, "v1");
		assert.deepEqual(off.recorded, []);
	}
	// engine v1 explícito vence o padrão global.
	assert.equal((await setup({ policyJson: { engine: "v1" }, globalDefault: "all" }).choose()).engine, "v1");
});

test("brief e lembrete check: perfil chat, mas com piso de orçamento do v1 (long_work do bot ou US$ 0,50, no mínimo 30 min)", async () => {
	const wide = { engine: "v2", engineScope: "all" };
	const base = setup({ policyJson: wide, origin: "routine", longerShortRun: true, shortRun: true, text: "Levante os pedidos e monte um relatório completo" });
	const choice = await base.choose();
	assert.equal(choice.profile, "chat");
	assert.deepEqual(choice.budgetFloor, { costUsd: 0.5, minutes: 30 });
	const custom = await setup({ policyJson: { ...wide, longWorkBudgetUsd: 2, longWorkMinutes: 45 }, origin: "proactive", longerShortRun: true, shortRun: true }).choose();
	assert.equal(custom.profile, "chat");
	assert.deepEqual(custom.budgetFloor, { costUsd: 2, minutes: 45 });
	// Alerta e evento de configuração (sem longerShortRun) seguem no teto do chat.
	assert.equal((await setup({ policyJson: wide, origin: "routine", shortRun: true }).choose()).budgetFloor, undefined);
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

test("escopo all: rotina, grupo, bot→bot, proativo, webhook e e-mail saem no v2 e gravam a escolha; o chat também", async () => {
	for (const [name, over] of [
		["rotina", { origin: "routine" }],
		["grupo", { origin: "chat", isGroupRun: true }],
		["bot→bot", { origin: "bot" }],
		["proativo", { origin: "proactive" }],
		["webhook", { origin: "webhook" }],
		["e-mail", { origin: "email" }],
		["chat", { origin: "chat" }],
	] as const) {
		const { choose, recorded } = setup({ policyJson: wide, ...over });
		assert.equal((await choose()).engine, "v2", name);
		assert.deepEqual(recorded, [{ engine: "v2", profile: "chat" }], name);
	}
});

test("escopo all não leva subagente ao v2", async () => {
	for (const origin of ["subagent"]) {
		const { choose, recorded } = setup({ policyJson: wide, origin });
		assert.equal((await choose()).engine, "v1", origin);
		assert.deepEqual(recorded, [], origin);
	}
});

test("e-mail recebido e webhook: o texto de fora não escolhe trabalho longo; o dono pode forçar", async () => {
	const report = "Levante os pedidos em aberto e monte um relatório comparativo com preços";
	assert.equal((await setup({ policyJson: wide, origin: "email", text: report }).choose()).profile, "chat");
	assert.equal((await setup({ policyJson: wide, origin: "webhook", text: report }).choose()).profile, "chat");
	assert.equal((await setup({ policyJson: { ...wide, workProfile: "long_work" }, origin: "webhook", text: "oi" }).choose()).profile, "long_work");
	assert.equal((await setup({ policyJson: { ...wide, workProfile: "long_work" }, origin: "email", text: "oi" }).choose()).profile, "long_work");
});

test("escopo chat explícito segura rotina, grupo, bot→bot, webhook e e-mail no v1", async () => {
	for (const over of [{ origin: "routine" }, { origin: "bot" }, { origin: "webhook" }, { origin: "email" }, { origin: "chat", isGroupRun: true }]) {
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

test("padrão global off (emergência): bot sem escolha volta ao v1 em nenhuma origem do v2", async () => {
	for (const over of [{ origin: "chat" }, { origin: "routine" }, { origin: "bot" }, { origin: "chat", isGroupRun: true }]) {
		const { choose, recorded } = setup({ policyJson: { planMode: true }, globalDefault: "off", ...over });
		assert.equal((await choose()).engine, "v1");
		assert.deepEqual(recorded, []);
	}
});

test("padrão ausente (sem variável): bot sem escolha vai ao v2 em todas as origens suportadas, subagente herda do pai", async () => {
	for (const over of [{ origin: "chat" }, { origin: "routine" }, { origin: "bot" }, { origin: "proactive" }, { origin: "webhook" }, { origin: "email" }, { origin: "chat", isGroupRun: true }]) {
		const { choose, recorded } = setup({ policyJson: { planMode: true }, ...over });
		assert.equal((await choose()).engine, "v2", JSON.stringify(over));
		assert.deepEqual(recorded, [{ engine: "v2", profile: "chat" }], JSON.stringify(over));
	}
	assert.equal((await setup({ origin: "subagent" }).choose()).engine, "v1");
});

test("run em andamento: o motor gravado vence o padrão; retomada com checkpoint e sem motor gravado fica no v1", async () => {
	assert.equal((await setup({ budgetJson: { engine: "v1" }, hasCheckpoint: true }).choose()).engine, "v1");
	assert.equal((await setup({ hasCheckpoint: true }).choose()).engine, "v1");
	assert.equal((await setup({ budgetJson: { engine: "v2", engineProfile: "chat" }, hasCheckpoint: true, globalDefault: "off" }).choose()).engine, "v2");
});

test("padrão global chat/all vale para bot sem escolha explícita", async () => {
	assert.equal((await setup({ globalDefault: "chat", origin: "chat" }).choose()).engine, "v2");
	assert.equal((await setup({ globalDefault: "chat", origin: "routine" }).choose()).engine, "v1");
	for (const over of [{ origin: "chat" }, { origin: "routine" }, { origin: "bot" }, { origin: "webhook" }, { origin: "email" }, { origin: "chat", isGroupRun: true }]) {
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

test("engineDefaultFromEnv lê ATLAS_ENGINE_V2_DEFAULT; ausente, vazio ou inválido é o padrão novo (all)", () => {
	assert.equal(engineDefaultFromEnv({}), "all");
	assert.equal(engineDefaultFromEnv({ ATLAS_ENGINE_V2_DEFAULT: "" }), "all");
	assert.equal(engineDefaultFromEnv({ ATLAS_ENGINE_V2_DEFAULT: "chat" }), "chat");
	assert.equal(engineDefaultFromEnv({ ATLAS_ENGINE_V2_DEFAULT: "ALL" }), "all");
	assert.equal(engineDefaultFromEnv({ ATLAS_ENGINE_V2_DEFAULT: "off" }), "off");
	assert.equal(engineDefaultFromEnv({ ATLAS_ENGINE_V2_DEFAULT: "sim" }), "all");
});

test("alerta, brief, proativo e config do bot (shortRun) saem no v2 sempre no perfil chat, mesmo com pedido de relatório ou long_work forçado", async () => {
	const report = "Levante os pedidos em aberto e monte um relatório comparativo com preços";
	for (const [name, over] of [
		["alerta/brief (rotina)", { origin: "routine" }],
		["proativo", { origin: "proactive" }],
		["config do bot (chat)", { origin: "chat" }],
	] as const) {
		const auto = setup({ policyJson: wide, text: report, shortRun: true, ...over });
		assert.deepEqual(await auto.choose(), { engine: "v2", profile: "chat", longWorkBudgetUsd: undefined, longWorkMinutes: 60, longWorkMinutesExplicit: false, helperModel: null, helperMaxParallel: 4 }, name);
		assert.deepEqual(auto.recorded, [{ engine: "v2", profile: "chat" }], name);
		const forced = setup({ policyJson: { ...wide, workProfile: "long_work" }, text: report, shortRun: true, ...over });
		assert.equal((await forced.choose()).profile, "chat", `${name} com long_work forçado`);
	}
	// Sem shortRun o pedido de relatório continua virando trabalho longo.
	assert.equal((await setup({ policyJson: wide, origin: "routine", text: report }).choose()).profile, "long_work");
});

test("alerta, brief e proativo seguem no v1 com v2/chat explícito ou v1 explícito", async () => {
	for (const over of [{ origin: "routine" }, { origin: "proactive" }]) {
		for (const policyJson of [{ engine: "v1" }, { engine: "v2" }, { engine: "v2", engineScope: "chat" }]) {
			const { choose, recorded } = setup({ policyJson, shortRun: true, ...over });
			assert.equal((await choose()).engine, "v1");
			assert.deepEqual(recorded, []);
		}
	}
});

const LONG_REQUEST = "Faça uma pesquisa de mercado completa e monte um relatório";

test("trabalho longo no chat com o dono: o teto por execução da conta (0,25) NÃO se aplica e o tempo é o do bot (60 min por padrão); chat curto fica com a conta", async () => {
	const snapshot = { maxRunCostUsd: 0.25 };
	const limits = (choice: Awaited<ReturnType<ReturnType<typeof setup>["choose"]>>, over: Partial<Parameters<typeof resolveRunLimits>[0]> = {}) =>
		resolveRunLimits({ choice, origin: "chat", humanTurn: true, requestOrBotCap: undefined, snapshot, wallFixed: false, ...over });
	// Sem nada configurado: conta com teto 0,25 não corta o trabalho longo; 60 min.
	const long = await setup({ policyJson: { engine: "v2" }, text: LONG_REQUEST }).choose();
	assert.deepEqual(longWorkOwnerLimits(long, HUMAN_CHAT), { ignoreAccountCostCap: true, wallMs: 60 * 60_000 });
	assert.deepEqual(limits(long), { costCapUsd: undefined, wallMs: 60 * 60_000 });
	// Tempo do bot ajustado (até 180).
	const custom = await setup({ policyJson: { engine: "v2", longWorkMinutes: 180 }, text: LONG_REQUEST }).choose();
	assert.equal(limits(custom).wallMs, 180 * 60_000);
	// Chat curto e v1 seguem com a conta.
	const chat = await setup({ policyJson: { engine: "v2", longWorkBudgetUsd: 1 }, text: "Bom dia" }).choose();
	assert.deepEqual(longWorkOwnerLimits(chat, HUMAN_CHAT), { ignoreAccountCostCap: false });
	assert.equal(limits(chat).costCapUsd, 0.25);
	assert.deepEqual(longWorkOwnerLimits({ engine: "v1", profile: "chat" }, HUMAN_CHAT), { ignoreAccountCostCap: false });
	// O teto do pedido (continuação com o que sobrou) continua valendo.
	assert.equal(limits(long, { requestOrBotCap: 0.3 }).costCapUsd, 0.3);
	// Tempo fixado no pedido ou na política do bot vence os minutos.
	assert.equal(limits(long, { wallFixed: true }).wallMs, undefined);
});

test("rotina, bot→bot, webhook, e-mail e chat sem o dono digitando ficam com o teto da conta (e sem o tempo do bot)", async () => {
	const choice = await setup({ policyJson: { engine: "v2", workProfile: "long_work", longWorkBudgetUsd: 1, longWorkMinutes: 40 } }).choose();
	const snapshot = { maxRunCostUsd: 0.25 };
	for (const [origin, human] of [["chat", false], ["routine", true], ["bot", false], ["webhook", false], ["email", false]] as const) {
		assert.deepEqual(resolveRunLimits({ choice, origin, humanTurn: human, requestOrBotCap: undefined, snapshot, wallFixed: false }), { costCapUsd: 0.25 }, `${origin}/${human}`);
	}
});

test("o gasto máximo opcional do bot (antigo longWorkBudgetUsd) vira teto duro; sem ele não há teto em US$", async () => {
	const none = await setup({ policyJson: { engine: "v2" }, text: LONG_REQUEST }).choose();
	assert.equal(none.longWorkBudgetUsd, undefined);
	const capped = await setup({ policyJson: { engine: "v2", longWorkBudgetUsd: 2 }, text: LONG_REQUEST }).choose();
	assert.equal(capped.longWorkBudgetUsd, 2);
	// Brief e `check` (perfil chat com piso): sem gasto máximo usam o piso do v1 (US$ 0,50 e 30 min), nunca o tempo de 60 min.
	const floor = await setup({ policyJson: { engine: "v2", engineScope: "all" }, origin: "routine", shortRun: true, longerShortRun: true }).choose();
	assert.deepEqual(floor.budgetFloor, { costUsd: 0.5, minutes: 30 });
});

test("origem sem dono em trabalho longo, com conta 'sem limite' e bot sem gasto máximo: piso de segurança de US$ 0,50", async () => {
	const choice = await setup({ policyJson: { engine: "v2", workProfile: "long_work", engineScope: "all" } }).choose();
	const unlimited = { maxRunCostUsd: undefined };
	for (const [origin, human] of [["routine", false], ["bot", false], ["proactive", false], ["webhook", false], ["email", false], ["chat", false]] as const) {
		assert.deepEqual(resolveRunLimits({ choice, origin, humanTurn: human, requestOrBotCap: undefined, snapshot: unlimited, wallFixed: false }), { costCapUsd: UNATTENDED_LONG_WORK_COST_FLOOR_USD }, origin);
	}
	// A conta com teto manda (0,25 < 0,50); o gasto máximo do bot também; o dono no chat continua sem teto.
	assert.equal(resolveRunLimits({ choice, origin: "routine", humanTurn: false, requestOrBotCap: undefined, snapshot: { maxRunCostUsd: 0.25 }, wallFixed: false }).costCapUsd, 0.25);
	const capped = await setup({ policyJson: { engine: "v2", workProfile: "long_work", engineScope: "all", longWorkBudgetUsd: 3 } }).choose();
	assert.equal(resolveRunLimits({ choice: capped, origin: "routine", humanTurn: false, requestOrBotCap: undefined, snapshot: unlimited, wallFixed: false }).costCapUsd, undefined);
	assert.equal(resolveRunLimits({ choice, origin: "chat", humanTurn: true, requestOrBotCap: undefined, snapshot: unlimited, wallFixed: false }).costCapUsd, undefined);
	// Chat curto não é trabalho longo: sem piso.
	const short = await setup({ policyJson: { engine: "v2", workProfile: "chat", engineScope: "all" } }).choose();
	assert.equal(resolveRunLimits({ choice: short, origin: "routine", humanTurn: false, requestOrBotCap: undefined, snapshot: unlimited, wallFixed: false }).costCapUsd, undefined);
});

test("run encadeado por falha transitória (ou resposta de questionário) dentro de um trabalho longo do dono mantém long_work e a isenção do teto da conta", async () => {
	const { readRunHumanTurn } = await import("@workspace/db");
	// O que o db grava no run filho a partir do pai (humanTurn, motor e perfil herdados).
	const budgetJson = { humanTurn: true, engine: "v2", engineProfile: "long_work" };
	const policyJson = { engine: "v2" };
	const { choose, recorded } = setup({ policyJson, budgetJson, hasCheckpoint: false, text: "Continue the previous task from where it stopped." });
	const choice = await choose();
	assert.equal(choice.engine, "v2");
	assert.equal(choice.profile, "long_work");
	assert.deepEqual(recorded, [], "motor e perfil já gravados: nada é escolhido de novo");
	const limits = resolveRunLimits({ choice, origin: "chat", humanTurn: readRunHumanTurn({ budgetJson }), requestOrBotCap: undefined, snapshot: { maxRunCostUsd: 0.25 }, wallFixed: false });
	assert.deepEqual(limits, { costCapUsd: undefined, wallMs: 60 * 60_000 });
	// Sem a herança o mesmo texto cairia em chat curto com o teto da conta.
	const lost = await setup({ policyJson, budgetJson: null, text: "Continue the previous task from where it stopped." }).choose();
	assert.equal(lost.profile, "chat");
});
