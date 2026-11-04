/**
 * Escolha do motor do run (ADR 0002, F2).
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/engine-choice.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { earlyWallMs, lessonsInjectedByEngine, engineDefaultFromEnv, longWorkOwnerLimits, pickRunEngine, priorTaskInheritance, resolveRunLimits } from "./engine-choice.js";
import type { EngineDefault } from "@workspace/shared";
import { effectiveCostCapUsd } from "./run-config.js";

const HUMAN_CHAT = { origin: "chat", humanTurn: true };

function setup(over: { policyJson?: unknown; budgetJson?: unknown; origin?: string; isGroupRun?: boolean; hasCheckpoint?: boolean; text?: string; forceV1?: boolean; shortRun?: boolean; longerShortRun?: boolean; globalDefault?: EngineDefault; accountId?: string; env?: Record<string, string | undefined> } = {}) {
	const recorded: Array<{ engine: string; profile: string }> = [];
	const choose = () =>
		pickRunEngine({
			run: { origin: over.origin ?? "chat", budgetJson: over.budgetJson ?? null },
			policyJson: over.policyJson ?? null,
			isGroupRun: over.isGroupRun ?? false,
			hasCheckpoint: over.hasCheckpoint ?? false,
			forceV1: over.forceV1,
			shortRun: over.shortRun,
			longerShortRun: over.longerShortRun,
			globalDefault: over.globalDefault,
			accountId: over.accountId,
			env: over.env,
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

test("policy v2 roda no v2, escolhe o perfil pela POLÍTICA do bot (nunca pelo texto do pedido) e grava a escolha no run", async () => {
	const chat = setup({ policyJson: { engine: "v2" }, text: "Bom dia" });
	assert.equal((await chat.choose()).profile, "chat");
	assert.deepEqual(chat.recorded, [{ engine: "v2", profile: "chat" }]);

	// Pedido de relatório em `auto` nasce em chat: quem promove é a lista de 3+ passos do modelo, no meio do run.
	const report = setup({ policyJson: { engine: "v2" }, text: "Faça uma pesquisa de mercado completa e monte um relatório" });
	assert.equal((await report.choose()).profile, "chat");
	const long = setup({ policyJson: { engine: "v2", workProfile: "long_work", longWorkBudgetUsd: 1, longWorkMinutes: 30 }, text: "Faça uma pesquisa de mercado completa e monte um relatório" });
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
	assert.deepEqual(await resumeV2.choose(), { engine: "v2", profile: "long_work", longWorkBudgetUsd: undefined, longWorkMinutes: undefined, longWorkMinutesExplicit: false, helperModel: null, helperMaxParallel: 4 });
	// Já gravado: não grava de novo.
	assert.deepEqual(resumeV2.recorded, []);
});

test("run com checkpoint e sem motor gravado nasceu no v1 e continua nele", async () => {
	const { choose, recorded } = setup({ policyJson: { engine: "v2" }, hasCheckpoint: true });
	assert.equal((await choose()).engine, "v1");
	assert.deepEqual(recorded, []);
});

test("engine v2 sem engineScope vale como all; só engineScope chat explícito segura rotina, webhook, proativo, bot→bot e grupo no v1", async () => {
	for (const origin of ["routine", "webhook", "proactive", "email", "bot"]) {
		assert.equal((await setup({ policyJson: { engine: "v2" }, origin }).choose()).engine, "v2", origin);
		assert.equal((await setup({ policyJson: { engine: "v2", engineScope: "chat" }, origin }).choose()).engine, "v1", origin);
	}
	assert.equal((await setup({ policyJson: { engine: "v2" }, isGroupRun: true }).choose()).engine, "v2");
	assert.equal((await setup({ policyJson: { engine: "v2", engineScope: "chat" }, isGroupRun: true }).choose()).engine, "v1");
	assert.equal((await setup({ policyJson: { engine: "v2" }, origin: "subagent" }).choose()).engine, "v1");
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
	assert.deepEqual(await config.choose(), { engine: "v2", profile: "chat", longWorkBudgetUsd: undefined, longWorkMinutes: undefined, longWorkMinutesExplicit: false, helperModel: null, helperMaxParallel: 4 });
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

test("brief e lembrete check: perfil chat, mas com piso de TEMPO do v1 (no mínimo 30 min) e sem piso em US$", async () => {
	const wide = { engine: "v2", engineScope: "all" };
	const base = setup({ policyJson: wide, origin: "routine", longerShortRun: true, shortRun: true, text: "Levante os pedidos e monte um relatório completo" });
	const choice = await base.choose();
	assert.equal(choice.profile, "chat");
	assert.deepEqual(choice.budgetFloor, { minutes: 30 });
	const custom = await setup({ policyJson: { ...wide, longWorkBudgetUsd: 2, longWorkMinutes: 45 }, origin: "proactive", longerShortRun: true, shortRun: true }).choose();
	assert.equal(custom.profile, "chat");
	assert.deepEqual(custom.budgetFloor, { minutes: 45 });
	// Alerta e evento de configuração (sem longerShortRun) seguem no teto do chat.
	assert.equal((await setup({ policyJson: wide, origin: "routine", shortRun: true }).choose()).budgetFloor, undefined);
});

test("se a escolha não puder ser gravada, o run roda no v1 (a retomada não troca de motor)", async () => {
	const base = { run: { origin: "chat", budgetJson: null }, policyJson: { engine: "v2" }, isGroupRun: false, hasCheckpoint: false, };
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

test("rotina no v2: o perfil vem da política do bot, não do texto da instrução", async () => {
	const report = setup({ policyJson: wide, origin: "routine", text: "Levante os pedidos em aberto e monte um relatório comparativo com preços" });
	assert.equal((await report.choose()).profile, "chat");
	const forced = setup({ policyJson: { ...wide, workProfile: "long_work" }, origin: "routine", text: "Me lembre de beber água" });
	assert.equal((await forced.choose()).profile, "long_work");
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

test("padrão global off (emergência) vale para todos os bots, inclusive engine v2 explícito; o motor gravado segue", async () => {
	for (const policyJson of [{ engine: "v2" }, { engine: "v2", engineScope: "all" }, { engine: "v1" }, null]) {
		const { choose, recorded } = setup({ policyJson, globalDefault: "off" });
		assert.equal((await choose()).engine, "v1", JSON.stringify(policyJson));
		assert.deepEqual(recorded, []);
	}
	assert.equal((await setup({ policyJson: { engine: "v2" }, globalDefault: "off", budgetJson: { engine: "v2", engineProfile: "chat" } }).choose()).engine, "v2");
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
		assert.deepEqual(await auto.choose(), { engine: "v2", profile: "chat", longWorkBudgetUsd: undefined, longWorkMinutes: undefined, longWorkMinutesExplicit: false, helperModel: null, helperMaxParallel: 4 }, name);
		assert.deepEqual(auto.recorded, [{ engine: "v2", profile: "chat" }], name);
		const forced = setup({ policyJson: { ...wide, workProfile: "long_work" }, text: report, shortRun: true, ...over });
		assert.equal((await forced.choose()).profile, "chat", `${name} com long_work forçado`);
	}
	// Sem shortRun, o trabalho longo só vem da política do bot (o texto do relatório não decide).
	assert.equal((await setup({ policyJson: wide, origin: "routine", text: report }).choose()).profile, "chat");
	assert.equal((await setup({ policyJson: { ...wide, workProfile: "long_work" }, origin: "routine", text: report }).choose()).profile, "long_work");
});

test("alerta, brief e proativo seguem no v1 com v2/chat explícito ou v1 explícito", async () => {
	for (const over of [{ origin: "routine" }, { origin: "proactive" }]) {
		for (const policyJson of [{ engine: "v1" }, { engine: "v2", engineScope: "chat" }]) {
			const { choose, recorded } = setup({ policyJson, shortRun: true, ...over });
			assert.equal((await choose()).engine, "v1");
			assert.deepEqual(recorded, []);
		}
	}
});

const LONG_REQUEST = "Faça uma pesquisa de mercado completa e monte um relatório";

test("sem teto em US$ nem de tempo por padrão no chat do dono; o tempo do bot só vale se o dono preencheu; run sem humano mantém o limite de antes", async () => {
	const none = { maxRunCostUsd: undefined };
	const limits = (choice: Awaited<ReturnType<ReturnType<typeof setup>["choose"]>>, over: Partial<Parameters<typeof resolveRunLimits>[0]> = {}) =>
		resolveRunLimits({ choice, origin: "chat", humanTurn: true, requestOrBotCap: undefined, snapshot: none, wallFixed: false, ...over });
	const long = await setup({ policyJson: { engine: "v2", workProfile: "long_work" }, text: LONG_REQUEST }).choose();
	// Decisão do dono (02/11): sem `longWorkMinutes` configurado não há wallMs (antes: 60 min).
	assert.deepEqual(longWorkOwnerLimits(long, HUMAN_CHAT), { canPromote: false });
	assert.deepEqual(limits(long), { costCapUsd: undefined, canPromote: false });
	const custom = await setup({ policyJson: { engine: "v2", workProfile: "long_work", longWorkMinutes: 180 }, text: LONG_REQUEST }).choose();
	assert.equal(limits(custom).wallMs, 180 * 60_000);
	assert.equal(limits(custom, { wallFixed: true }).wallMs, undefined);
	// Chat curto: sem teto em US$, sem tempo e promovível (pela lista de 3+ passos).
	const chat = await setup({ policyJson: { engine: "v2", longWorkBudgetUsd: 1 }, text: "Bom dia" }).choose();
	assert.deepEqual(limits(chat), { costCapUsd: undefined, canPromote: true });
	// Com tempo do bot preenchido, o chat promovível leva o mesmo teto.
	const chatTimed = await setup({ policyJson: { engine: "v2", longWorkMinutes: 25 }, text: "Bom dia" }).choose();
	assert.deepEqual(limits(chatTimed), { costCapUsd: undefined, wallMs: 25 * 60_000, canPromote: true });
	// v1, origem sem humano e chat sem turno digitado: nada de promoção nem tempo do bot.
	assert.deepEqual(longWorkOwnerLimits({ engine: "v1", profile: "chat" }, HUMAN_CHAT), { canPromote: false });
	const wide = await setup({ policyJson: { engine: "v2", engineScope: "all" }, text: "Bom dia" }).choose();
	// Sem humano no chat: nada de promoção, e o limite de tempo de antes continua (chat curto: 8 min; rotina não perde o freio).
	for (const [origin, human] of [["chat", false], ["routine", true], ["webhook", false], ["email", false], ["proactive", false]] as const) {
		assert.deepEqual(limits(wide, { origin, humanTurn: human }), { costCapUsd: undefined, wallMs: 8 * 60_000, canPromote: false }, `${origin}/${human}`);
	}
	// Rotina e run de bot sem humano PODEM promover (lista de 3+ itens ou 1ª tool de navegador): o teto de tempo sem humano segue
	// valendo (30 min, o do trabalho longo sem humano) desde o começo, para a promoção não herdar o teto curto do chat.
	for (const origin of ["routine", "bot"] as const) {
		assert.deepEqual(limits(wide, { origin, humanTurn: false }), { costCapUsd: undefined, wallMs: 30 * 60_000, canPromote: true }, origin);
		// Os minutos do bot (pensados para o chat do dono) não estendem o run sem humano além de 30.
		const timed = await setup({ policyJson: { engine: "v2", engineScope: "all", longWorkMinutes: 90 }, text: "Bom dia" }).choose();
		assert.equal(limits(timed, { origin, humanTurn: false }).wallMs, 30 * 60_000, origin);
		// Verificação curta (alerta, brief, check, proativo) nunca promove.
		assert.equal(limits(wide, { origin, humanTurn: false, shortRun: true }).canPromote, false, `${origin}/curta`);
	}
	// Tempo fixado pelo dono continua vencendo.
	assert.equal(limits(wide, { origin: "routine", humanTurn: false, wallFixed: true }).wallMs, undefined);
	// O que o dono fixou (pedido, bot ou conta) vale mais que o limite padrão da rotina.
	assert.equal(limits(wide, { origin: "routine", humanTurn: false, wallFixed: true }).wallMs, undefined);
	assert.equal(limits(wide, { origin: "routine", humanTurn: false, snapshot: { maxRunCostUsd: undefined, maxWallMinutes: 5 } }).wallMs, undefined);
	// Trabalho longo sem dono (rotina) sem nenhum teto: continua sem teto em US$ (só tempo e passos protegem).
	const routineLong = await setup({ policyJson: { engine: "v2", workProfile: "long_work", engineScope: "all" } }).choose();
	assert.equal(limits(routineLong, { origin: "routine", humanTurn: false }).costCapUsd, undefined);
	// ...mas o tempo da rotina de trabalho longo mantém o teto efetivo de antes (30 min; os minutos do bot, se houver) e o v1 também.
	assert.equal(limits(routineLong, { origin: "routine", humanTurn: false }).wallMs, 30 * 60_000);
	const routineTimed = await setup({ policyJson: { engine: "v2", workProfile: "long_work", engineScope: "all", longWorkMinutes: 45 } }).choose();
	// Run sem humano nunca passa de 30 min pelos minutos do bot (pensados para o chat do dono); abaixo de 30 vale o do bot.
	assert.equal(limits(routineTimed, { origin: "routine", humanTurn: false }).wallMs, 30 * 60_000);
	const routineShort = await setup({ policyJson: { engine: "v2", workProfile: "long_work", engineScope: "all", longWorkMinutes: 10 } }).choose();
	assert.equal(limits(routineShort, { origin: "routine", humanTurn: false }).wallMs, 10 * 60_000);
	// Tempo fixado na conta ou no pedido passa dos 30 (o worker nem aplica o teto padrão).
	assert.equal(limits(routineTimed, { origin: "routine", humanTurn: false, wallFixed: true }).wallMs, undefined);
	assert.equal(earlyWallMs(0, true), 30 * 60_000);
	assert.equal(earlyWallMs(0, false), 0);
	assert.equal(earlyWallMs(5 * 60_000, true), 5 * 60_000);
	assert.equal(limits({ engine: "v1", profile: "chat" }, { origin: "routine", humanTurn: false }).wallMs, 30 * 60_000);
	assert.equal(limits({ engine: "v1", profile: "chat" }).wallMs, undefined, "chat humano no v1 também não tem teto de tempo");
	// Brief e lembrete `check` sem humano: o piso de 30 min.
	const brief = await setup({ policyJson: { engine: "v2", engineScope: "all" }, origin: "routine", shortRun: true, longerShortRun: true }).choose();
	assert.equal(limits(brief, { origin: "routine", humanTurn: false }).wallMs, 30 * 60_000);
});

test("só vale teto que o dono programou: conta explícita vale em tudo (trabalho longo incluso), pedido e gasto máximo do bot também", async () => {
	const account = { maxRunCostUsd: 0.25 };
	const long = await setup({ policyJson: { engine: "v2", longWorkBudgetUsd: 1, longWorkMinutes: 40 }, text: LONG_REQUEST }).choose();
	const chat = await setup({ policyJson: { engine: "v2" }, text: "Bom dia" }).choose();
	for (const choice of [long, chat]) {
		for (const [origin, human] of [["chat", true], ["chat", false], ["routine", false], ["bot", false], ["webhook", false]] as const) {
			assert.equal(resolveRunLimits({ choice, origin, humanTurn: human, requestOrBotCap: undefined, snapshot: account, wallFixed: false }).costCapUsd, 0.25, `${origin}/${human}`);
		}
	}
	// O menor entre conta e pedido/bot.
	assert.equal(resolveRunLimits({ choice: long, origin: "chat", humanTurn: true, requestOrBotCap: 0.1, snapshot: account, wallFixed: false }).costCapUsd, 0.1);
	assert.equal(resolveRunLimits({ choice: long, origin: "chat", humanTurn: true, requestOrBotCap: 3, snapshot: account, wallFixed: false }).costCapUsd, 0.25);
});

test("o gasto máximo opcional do bot (antigo longWorkBudgetUsd) vira teto duro; sem ele não há teto em US$", async () => {
	const none = await setup({ policyJson: { engine: "v2" }, text: LONG_REQUEST }).choose();
	assert.equal(none.longWorkBudgetUsd, undefined);
	const capped = await setup({ policyJson: { engine: "v2", longWorkBudgetUsd: 2 }, text: LONG_REQUEST }).choose();
	assert.equal(capped.longWorkBudgetUsd, 2);
	// Brief e `check` (perfil chat com piso de tempo): 30 min, nunca o tempo de 60 min, sem piso em US$.
	const floor = await setup({ policyJson: { engine: "v2", engineScope: "all" }, origin: "routine", shortRun: true, longerShortRun: true }).choose();
	assert.deepEqual(floor.budgetFloor, { minutes: 30 });
});

test("run encadeado por falha transitória (ou resposta de questionário) dentro de um trabalho longo do dono mantém long_work e o tempo do bot", async () => {
	const { readRunHumanTurn } = await import("@workspace/db");
	// O que o db grava no run filho a partir do pai (humanTurn, motor e perfil herdados).
	const budgetJson = { humanTurn: true, engine: "v2", engineProfile: "long_work" };
	const policyJson = { engine: "v2" };
	const { choose, recorded } = setup({ policyJson, budgetJson, hasCheckpoint: false, text: "Continue the previous task from where it stopped." });
	const choice = await choose();
	assert.equal(choice.engine, "v2");
	assert.equal(choice.profile, "long_work");
	assert.deepEqual(recorded, [], "motor e perfil já gravados: nada é escolhido de novo");
	const limits = resolveRunLimits({ choice, origin: "chat", humanTurn: readRunHumanTurn({ budgetJson }), requestOrBotCap: undefined, snapshot: { maxRunCostUsd: undefined }, wallFixed: false });
	assert.deepEqual(limits, { costCapUsd: undefined, canPromote: false });
	// Sem a herança o mesmo texto cairia em chat curto (promovível).
	const lost = await setup({ policyJson, budgetJson: null, text: "Continue the previous task from where it stopped." }).choose();
	assert.equal(lost.profile, "chat");
});

test("o tempo máximo programado na conta é teto duro: o chat e a promoção não recebem os minutos do bot", async () => {
	const chat = await setup({ policyJson: { engine: "v2", longWorkMinutes: 60 }, text: "Bom dia" }).choose();
	const long = await setup({ policyJson: { engine: "v2", longWorkMinutes: 60 }, text: LONG_REQUEST }).choose();
	for (const choice of [chat, long]) {
		const withAccount = resolveRunLimits({ choice, origin: "chat", humanTurn: true, requestOrBotCap: undefined, snapshot: { maxRunCostUsd: undefined, maxWallMinutes: 5 }, wallFixed: false });
		assert.equal(withAccount.wallMs, undefined, "sem wallMs: vale o tempo da conta (5 min) em budget.maxWallMs");
		const without = resolveRunLimits({ choice, origin: "chat", humanTurn: true, requestOrBotCap: undefined, snapshot: { maxRunCostUsd: undefined }, wallFixed: false });
		assert.equal(without.wallMs, 60 * 60_000);
	}
});

test("teto de passos: a origem só existe quando o dono configurou; acima do limite de segurança do v2 vale o de segurança (200), sem origem", async () => {
	const { stepsSourceOf, effectiveStepsCap, runCapsOf } = await import("./run-config.js");
	assert.equal(stepsSourceOf({}), undefined);
	assert.equal(stepsSourceOf({ account: 150 }), "account");
	assert.equal(stepsSourceOf({ account: 150, bot: 80 }), "bot");
	assert.equal(stepsSourceOf({ account: 150, bot: 80, request: 30 }), "request");
	assert.deepEqual(effectiveStepsCap({ engine: "v2", hardMaxSteps: 80, source: "bot" }), { steps: 80, stepsSource: "bot" });
	// Sem configuração: o padrão do código (300) é cortado em 200 e não é "o que você configurou".
	assert.deepEqual(effectiveStepsCap({ engine: "v2", hardMaxSteps: 300, source: undefined }), { steps: 200 });
	// O dono configurou 300: o teto efetivo é 200 e a origem some (é o de segurança que vale).
	assert.deepEqual(effectiveStepsCap({ engine: "v2", hardMaxSteps: 300, source: "account" }), { steps: 200 });
	assert.deepEqual(effectiveStepsCap({ engine: "v1", hardMaxSteps: 300, source: "account" }), { steps: 300, stepsSource: "account" });
	assert.deepEqual(runCapsOf({ costCapUsd: undefined, wallMs: undefined, sources: {}, stepsCap: { steps: 80, stepsSource: "bot" } }), { steps: 80, stepsSource: "bot" });
});

test("bot com engine v3: grava v3 só com flag + allowlist; senão roda e grava v2", async () => {
	for (const env of [{}, { ATLAS_ENGINE_V3: "off", ATLAS_ENGINE_V3_ACCOUNTS: "user-a" }, { ATLAS_ENGINE_V3_ACCOUNTS: "user-b" }]) {
		const { recorded, choose } = setup({ policyJson: { engine: "v3" }, accountId: "user-a", env });
		const choice = await choose();
		assert.equal(choice.engine, "v2", JSON.stringify(env));
		assert.equal(choice.resolved, "v2", JSON.stringify(env));
		assert.deepEqual(recorded, [{ engine: "v2", profile: "chat" }], JSON.stringify(env));
	}
	const { recorded, choose } = setup({ policyJson: { engine: "v3" }, accountId: "user-a", env: { ATLAS_ENGINE_V3_ACCOUNTS: "user-a" } });
	const inList = await choose();
	assert.equal(inList.engine, "v2");
	assert.equal(inList.resolved, "v3");
	assert.deepEqual(recorded, [{ engine: "v3", profile: "chat" }]);
});

test("motivo real da escolha do v3 (log do worker)", async () => {
	const { v3ResolutionReason } = await import("./engine-choice.js");
	assert.equal(v3ResolutionReason({ resolved: "v3", accountId: "a" }), "flag ligada e conta na allowlist");
	assert.equal(v3ResolutionReason({ resolved: "v2", accountId: "a", env: { ATLAS_ENGINE_V3: "off" } }), "ATLAS_ENGINE_V3=off");
	assert.equal(v3ResolutionReason({ resolved: "v2", accountId: "" }), "run sem conta");
	assert.equal(v3ResolutionReason({ resolved: "v2", accountId: "a", env: {} }), "conta fora de ATLAS_ENGINE_V3_ACCOUNTS");
});

test("log da escolha do v3 leva runId, botId e o motivo", async () => {
	const lines: string[] = [];
	const original = console.info;
	console.info = (line: unknown) => { lines.push(String(line)); };
	try {
		await pickRunEngine({ run: { origin: "chat", budgetJson: null }, policyJson: { engine: "v3" }, isGroupRun: false, hasCheckpoint: false, accountId: "user-a", env: {}, runId: "run-9", botId: "bot-7", record: async (choice) => choice.engine });
	} finally {
		console.info = original;
	}
	assert.deepEqual(lines, ["[engine] run=run-9 bot=bot-7 v3 pedido → v2 (conta fora de ATLAS_ENGINE_V3_ACCOUNTS)"]);
});

test("run com engine v3 gravado retoma no v3 enquanto a flag deixar; sem a flag, no v2; nunca regrava", async () => {
	const back = setup({ budgetJson: { engine: "v3" }, hasCheckpoint: true, policyJson: { engine: "v3" }, accountId: "user-a", env: { ATLAS_ENGINE_V3_ACCOUNTS: "user-a" } });
	const resumed = await back.choose();
	assert.equal(resumed.engine, "v2");
	assert.equal(resumed.resolved, "v3");
	assert.deepEqual(back.recorded, []);
	// O bot pode ter voltado ao v2 depois: o run que nasceu no v3 continua no v3 (o motor é do run).
	const botChanged = await setup({ budgetJson: { engine: "v3" }, hasCheckpoint: true, policyJson: { engine: "v2" }, accountId: "user-a", env: { ATLAS_ENGINE_V3_ACCOUNTS: "user-a" } }).choose();
	assert.equal(botChanged.resolved, "v3");
	const off = setup({ budgetJson: { engine: "v3" }, hasCheckpoint: true, policyJson: { engine: "v3" }, accountId: "user-a", env: { ATLAS_ENGINE_V3: "off", ATLAS_ENGINE_V3_ACCOUNTS: "user-a" } });
	const fallback = await off.choose();
	assert.equal(fallback.engine, "v2");
	assert.equal(fallback.resolved, "v2");
	assert.deepEqual(off.recorded, []);
});

test("runSelectedEngine: com o v3 resolvido roda o motor v3; sem ele, o v2 (mesma entrada e saída)", async () => {
	const { runSelectedEngine } = await import("./engine-choice.js");
	const run = async (resolved: "v2" | "v3") => {
		const engines: string[] = [];
		const result = await runSelectedEngine({ engine: "v2", resolved, profile: "chat" }, {
			manager: {} as never,
			getSessionId: async () => "s",
			sandboxEnabled: false,
			model: "m",
			apiKey: "k",
			runId: `run-${resolved}`,
			origin: "chat",
			humanTurn: true,
			messages: [{ role: "user", content: "oi" }],
			onEvent: () => undefined,
			onStep: async (step) => {
				const engine = (step.outputJson as { engine?: unknown } | undefined)?.engine;
				if (typeof engine === "string") engines.push(engine);
			},
			streamChat: async () => ({ model: "m", message: { role: "assistant", content: "olá" }, finishReason: "stop" }),
		});
		return { result, engines };
	};
	const v3 = await run("v3");
	assert.equal(v3.result.text, "olá");
	assert.ok(v3.engines.includes("v3"), JSON.stringify(v3.engines));
	const v2 = await run("v2");
	assert.equal(v2.result.text, "olá");
	assert.ok(v2.engines.includes("v2") && !v2.engines.includes("v3"), JSON.stringify(v2.engines));
});

test("motor v3 sem humano: sem relógio padrão (D4: valem os 40 passos e o US$ do dono); tempo fixado pelo dono continua valendo", async () => {
	const none = { maxRunCostUsd: undefined };
	const v3 = { engine: "v2" as const, resolved: "v3" as const, profile: "chat" as const };
	for (const origin of ["routine", "webhook", "email", "proactive", "bot"] as const) {
		assert.equal(resolveRunLimits({ choice: v3, origin, humanTurn: false, requestOrBotCap: undefined, snapshot: none, wallFixed: false, canParkAtLimit: true }).wallMs, undefined, origin);
	}
	// O v2 sem humano continua com o limite de antes (rotina promovível: 30 min).
	assert.equal(resolveRunLimits({ choice: { engine: "v2", profile: "chat" }, origin: "routine", humanTurn: false, requestOrBotCap: undefined, snapshot: none, wallFixed: false }).wallMs, 30 * 60_000);
	// Tempo máximo da conta é do dono: vale também no v3 (o worker o passa no orçamento do run).
	assert.equal(resolveRunLimits({ choice: v3, origin: "routine", humanTurn: false, requestOrBotCap: 0.5, snapshot: { maxRunCostUsd: undefined, maxWallMinutes: 20 }, wallFixed: false }).costCapUsd, 0.5);
});

test("lessonsInjectedByEngine: o v3 não conta lição como injetada; v1 e v2 contam", () => {
	assert.deepEqual(lessonsInjectedByEngine({ resolved: "v3" }, ["l1", "l2"]), []);
	assert.deepEqual(lessonsInjectedByEngine({ resolved: "v2" }, ["l1", "l2"]), ["l1", "l2"]);
	assert.deepEqual(lessonsInjectedByEngine({}, ["l1"]), ["l1"]);
});

test("motor v3 sem humano e sem cartão possível (sem conversa, subagente, dono legado): o relógio de antes continua", () => {
	const none = { maxRunCostUsd: undefined };
	const v3 = { engine: "v2" as const, resolved: "v3" as const, profile: "chat" as const };
	const v2Routine = resolveRunLimits({ choice: { engine: "v2", profile: "chat" }, origin: "routine", humanTurn: false, requestOrBotCap: undefined, snapshot: none, wallFixed: false }).wallMs;
	assert.equal(resolveRunLimits({ choice: v3, origin: "routine", humanTurn: false, requestOrBotCap: undefined, snapshot: none, wallFixed: false, canParkAtLimit: false }).wallMs, v2Routine);
	assert.equal(resolveRunLimits({ choice: v3, origin: "routine", humanTurn: false, requestOrBotCap: undefined, snapshot: none, wallFixed: false }).wallMs, v2Routine);
	assert.ok(resolveRunLimits({ choice: v3, origin: "proactive", humanTurn: false, requestOrBotCap: undefined, snapshot: none, wallFixed: false, shortRun: true }).wallMs !== undefined);
});

test("lista do run anterior (PR8e): v3 segue o v2; 'Bom dia' sem trabalho aberto não herda; 'Continua' recebe só a nota; v1 igual", () => {
	const list = [{ content: "Comparar fornecedores", status: "in_progress" }];
	const v3 = { engine: "v2" as const, resolved: "v3" as const };
	const v2 = { engine: "v2" as const };
	// "Bom dia" depois de um run que NÃO parou com itens abertos: nada (nem lista semeada, nem nota).
	assert.deepEqual(priorTaskInheritance({ choice: v3, planSeeded: false, autoContinueAttempt: 0, typedContinuation: false, priorTaskList: list }), {});
	// Mensagem digitada depois de um run com itens abertos: os itens vão como nota de contexto, a lista não é semeada.
	assert.deepEqual(priorTaskInheritance({ choice: v3, planSeeded: false, autoContinueAttempt: 0, typedContinuation: true, priorTaskList: list }), { priorOpenItems: list });
	// Continuação automática e plano aprovado: a lista segue com o run.
	assert.deepEqual(priorTaskInheritance({ choice: v3, planSeeded: false, autoContinueAttempt: 1, typedContinuation: false, priorTaskList: list }), { priorTaskList: list });
	assert.deepEqual(priorTaskInheritance({ choice: v3, planSeeded: true, autoContinueAttempt: 0, typedContinuation: false, priorTaskList: list }), { priorTaskList: list });
	// v2 igual ao v3; v1 como sempre (semeia sempre).
	assert.deepEqual(priorTaskInheritance({ choice: v2, planSeeded: false, autoContinueAttempt: 0, typedContinuation: true, priorTaskList: list }), { priorOpenItems: list });
	assert.deepEqual(priorTaskInheritance({ choice: v2, planSeeded: false, autoContinueAttempt: 0, typedContinuation: false, priorTaskList: list }), {});
	assert.deepEqual(priorTaskInheritance({ choice: { engine: "v1" }, planSeeded: false, autoContinueAttempt: 0, typedContinuation: false, priorTaskList: list }), { priorTaskList: list });
	assert.deepEqual(priorTaskInheritance({ choice: v3, planSeeded: false, autoContinueAttempt: 0, typedContinuation: true, priorTaskList: null }), {});
});
