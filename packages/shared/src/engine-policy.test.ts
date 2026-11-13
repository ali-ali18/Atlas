import { describe, expect, it } from "vitest";
import {
	ENGINE_DEFAULT_SCOPE,
	chooseRunEngine,
	engineV2SupportsRun,
	readEngineDefault,
	resolveBotEngineRouting,
	type EngineDefault,
	readRunCaps,
	withRunCaps,
	readEnginePolicy,
	readRunEngine,
	readRunProfile,
	readRunPromotedFrom,
	withRunPromotion,
	resolveRunProfile,
	withBotEngine,
	withRunEngine,
} from "./engine-policy.js";
import { ENGINE_V4_OFF, readEngineV4Gate } from "./engine-policy-v4.js";

describe("readEnginePolicy", () => {
	it("bot sem política usa o motor novo (padrão) em todas as origens, perfil automático, sem limite de gasto e sem tempo máximo explícito (longWorkMinutes só vale se o dono preencheu)", () => {
		expect(ENGINE_DEFAULT_SCOPE).toBe("all");
		for (const raw of [null, undefined, {}, [], "x", 3]) {
			expect(readEnginePolicy(raw)).toEqual({
				engine: "v2",
				explicit: undefined,
				scope: ENGINE_DEFAULT_SCOPE,
				scopeRaw: undefined,
				workProfile: "auto",
				longWorkBudgetUsd: undefined,
				longWorkMinutes: 60,
				longWorkMinutesExplicit: false,
			});
		}
	});

	it("lê v2 e os ajustes do bot", () => {
		expect(readEnginePolicy({ engine: "v2", workProfile: "long_work", longWorkBudgetUsd: 1.25, longWorkMinutes: 45 })).toEqual({
			engine: "v2",
			explicit: "v2",
			scope: "all",
			scopeRaw: undefined,
			workProfile: "long_work",
			longWorkBudgetUsd: 1.25,
			longWorkMinutes: 45,
			longWorkMinutesExplicit: true,
		});
	});

	it("gasto máximo é opcional (vazio = sem limite); valor inválido não vira teto; tempo explícito é marcado", () => {
		expect(readEnginePolicy({ longWorkBudgetUsd: 1 })).toMatchObject({ longWorkBudgetUsd: 1, longWorkMinutesExplicit: false });
		expect(readEnginePolicy({ longWorkMinutes: 30, longWorkBudgetUsd: "caro" })).toMatchObject({ longWorkBudgetUsd: undefined, longWorkMinutesExplicit: true });
		// Bot antigo com `longWorkBudgetUsd` gravado: vira o teto opcional.
		expect(readEnginePolicy({ engine: "v2", longWorkBudgetUsd: 0.5 }).longWorkBudgetUsd).toBe(0.5);
	});

	it("valor inválido cai no padrão e número fora da faixa é limitado", () => {
		const policy = readEnginePolicy({ engine: "v3", workProfile: "turbo", longWorkBudgetUsd: "caro", longWorkMinutes: 9999 });
		expect(policy.engine).toBe("v2");
		expect(policy.explicit).toBeUndefined();
		expect(policy.workProfile).toBe("auto");
		expect(policy.longWorkBudgetUsd).toBeUndefined();
		expect(policy.longWorkMinutes).toBe(180);
		expect(readEnginePolicy({ longWorkBudgetUsd: -3 }).longWorkBudgetUsd).toBeUndefined();
		expect(readEnginePolicy({ longWorkBudgetUsd: 0.01 }).longWorkBudgetUsd).toBe(0.05);
	});

	it("lê o escopo e a escolha explícita; v2 sem escopo (ou inválido) vale como all, só engineScope chat limita", () => {
		expect(readEnginePolicy({ engine: "v2", engineScope: "all" })).toMatchObject({ engine: "v2", explicit: "v2", scope: "all" });
		expect(readEnginePolicy({ engine: "v1" })).toMatchObject({ engine: "v1", explicit: "v1" });
		expect(readEnginePolicy({}).explicit).toBeUndefined();
		expect(readEnginePolicy({ engine: "v2", engineScope: "chat" })).toMatchObject({ scope: "chat", scopeRaw: "chat" });
		for (const bad of ["tudo", "ALL", 1, null, true, undefined]) expect(readEnginePolicy({ engine: "v2", engineScope: bad }).scope).toBe("all");
		// Sem escolha explícita a UI mostra o escopo do padrão; com v1 ou v2 explícitos, só o que o bot salvou.
		expect(readEnginePolicy({}).scope).toBe(ENGINE_DEFAULT_SCOPE);
		expect(readEnginePolicy({ engine: "v1" }).scope).toBe("chat");
	});

	it("withBotEngine liga e desliga sem perder as outras chaves; v1 fica explícito e desliga o escopo", () => {
		const on = withBotEngine({ planMode: false }, "v2");
		expect(on).toEqual({ planMode: false, engine: "v2" });
		expect(withBotEngine({ ...on, engineScope: "all" }, "v1")).toEqual({ planMode: false, engine: "v1" });
	});
});

describe("motor gravado no run", () => {
	it("lê e grava preservando o resto do budgetJson", () => {
		expect(readRunEngine(null)).toBeUndefined();
		expect(readRunEngine({ engine: "x" })).toBeUndefined();
		const stored = withRunEngine({ humanTurn: true, contextLength: 1000 }, { engine: "v2", profile: "long_work" });
		expect(stored).toEqual({ humanTurn: true, contextLength: 1000, engine: "v2", engineProfile: "long_work" });
		expect(readRunEngine(stored)).toBe("v2");
		expect(readRunProfile(stored)).toBe("long_work");
		expect(readRunProfile({ engineProfile: "x" })).toBeUndefined();
	});
});

describe("chooseRunEngine", () => {
	const v2 = readEnginePolicy({ engine: "v2" });
	const v1 = readEnginePolicy(null);

	it("bot sem política roda no v2 (padrão); v1 explícito fica no v1", () => {
		expect(chooseRunEngine({ policy: v1, origin: "chat", isGroupRun: false })).toBe("v2");
		expect(chooseRunEngine({ policy: readEnginePolicy({ engine: "v1" }), origin: "chat", isGroupRun: false })).toBe("v1");
		expect(chooseRunEngine({ policy: v2, origin: "chat", isGroupRun: false })).toBe("v2");
	});

	it("a retomada respeita o motor gravado, mesmo que o bot tenha mudado", () => {
		expect(chooseRunEngine({ stored: "v1", policy: v2, origin: "chat", isGroupRun: false })).toBe("v1");
		expect(chooseRunEngine({ stored: "v2", policy: readEnginePolicy({ engine: "v1" }), origin: "chat", isGroupRun: false })).toBe("v2");
	});

	it("v2 sem engineScope vale como all; engineScope chat explícito: rotina, webhook, proativo, e-mail, bot→bot, grupo e subagente ficam no v1", () => {
		for (const origin of ["routine", "webhook", "proactive", "email", "bot"]) {
			expect(chooseRunEngine({ policy: v2, origin, isGroupRun: false }), origin).toBe("v2");
		}
		expect(chooseRunEngine({ policy: v2, origin: "chat", isGroupRun: true })).toBe("v2");
		expect(chooseRunEngine({ policy: v2, origin: "subagent", isGroupRun: false })).toBe("v1");
		const chatOnly = readEnginePolicy({ engine: "v2", engineScope: "chat" });
		for (const origin of ["routine", "webhook", "proactive", "email", "bot", "subagent"]) {
			expect(chooseRunEngine({ policy: chatOnly, origin, isGroupRun: false }), origin).toBe("v1");
		}
		expect(chooseRunEngine({ policy: chatOnly, origin: "chat", isGroupRun: true })).toBe("v1");
		expect(engineV2SupportsRun({ origin: "chat", isGroupRun: false, isSubagent: true })).toBe(false);
	});
});

describe("padrão global (ATLAS_ENGINE_V2_DEFAULT)", () => {
	it("lê off, chat e all; ausente, vazio ou desconhecido é o padrão novo (all)", () => {
		expect(readEngineDefault("chat")).toBe("chat");
		expect(readEngineDefault(" ALL ")).toBe("all");
		expect(readEngineDefault(" OFF ")).toBe("off");
		for (const raw of [undefined, null, "", "  ", "v2", "true", "false", 1]) expect(readEngineDefault(raw), String(raw)).toBe(ENGINE_DEFAULT_SCOPE);
	});

	it("resolveBotEngineRouting: escolha explícita vence; sem ela vale o padrão", () => {
		const none = readEnginePolicy({});
		expect(resolveBotEngineRouting(none)).toEqual({ engine: "v2", scope: "all" });
		expect(resolveBotEngineRouting(none, "off")).toEqual({ engine: "v1", scope: "chat" });
		expect(resolveBotEngineRouting(none, "chat")).toEqual({ engine: "v2", scope: "chat" });
		expect(resolveBotEngineRouting(none, "all")).toEqual({ engine: "v2", scope: "all" });
		expect(resolveBotEngineRouting(readEnginePolicy({ engine: "v1", engineScope: "all" }), "all")).toEqual({ engine: "v1", scope: "chat" });
		// `off` é a emergência: desliga o motor novo para todos, até para quem escolheu o v2.
		expect(resolveBotEngineRouting(readEnginePolicy({ engine: "v2", engineScope: "all" }), "off")).toEqual({ engine: "v1", scope: "chat" });
		expect(resolveBotEngineRouting(readEnginePolicy({ engine: "v2" }), "off")).toEqual({ engine: "v1", scope: "chat" });
		expect(resolveBotEngineRouting(readEnginePolicy({ engine: "v2" }), "all")).toEqual({ engine: "v2", scope: "all" });
		expect(resolveBotEngineRouting(readEnginePolicy({ engine: "v2" }), "chat")).toEqual({ engine: "v2", scope: "all" });
		expect(resolveBotEngineRouting(readEnginePolicy({ engine: "v2", engineScope: "chat" }), "all")).toEqual({ engine: "v2", scope: "chat" });
		// Sem escolha explícita mas com "usar também em rotinas e grupos" salvo: vale o maior escopo.
		const scopeOnly = readEnginePolicy({ engineScope: "all" });
		expect(resolveBotEngineRouting(scopeOnly, "chat")).toEqual({ engine: "v2", scope: "all" });
		expect(resolveBotEngineRouting(scopeOnly, "off")).toEqual({ engine: "v1", scope: "chat" });
	});
});

describe("tabela de decisão: origem × motor do bot × escopo × padrão global × gravado × forceV1", () => {
	type Bot = "sem escolha" | "v1" | "v2 sem escopo" | "v2/chat" | "v2/all";
	const bots: Record<Bot, unknown> = {
		"sem escolha": {},
		v1: { engine: "v1", engineScope: "all" },
		"v2 sem escopo": { engine: "v2" },
		"v2/chat": { engine: "v2", engineScope: "chat" },
		"v2/all": { engine: "v2", engineScope: "all" },
	};
	type Where = "chat" | "grupo" | "routine" | "bot" | "webhook" | "email" | "proactive" | "subagent";
	const run = (where: Where) => ({
		origin: where === "grupo" ? "chat" : where,
		isGroupRun: where === "grupo",
		isSubagent: where === "subagent" ? true : undefined,
	});
	// Linhas: [bot, padrão global] -> origens que rodam no v2.
	const expected: Array<[Bot, EngineDefault, Where[]]> = [
		["sem escolha", "off", []],
		["sem escolha", "chat", ["chat"]],
		["sem escolha", "all", ["chat", "grupo", "routine", "bot", "webhook", "email", "proactive"]],
		["v1", "off", []],
		["v1", "chat", []],
		["v1", "all", []],
		["v2 sem escopo", "off", []],
		["v2 sem escopo", "chat", ["chat", "grupo", "routine", "bot", "webhook", "email", "proactive"]],
		["v2 sem escopo", "all", ["chat", "grupo", "routine", "bot", "webhook", "email", "proactive"]],
		["v2/chat", "off", []],
		["v2/chat", "chat", ["chat"]],
		["v2/chat", "all", ["chat"]],
		["v2/all", "off", []],
		["v2/all", "chat", ["chat", "grupo", "routine", "bot", "webhook", "email", "proactive"]],
		["v2/all", "all", ["chat", "grupo", "routine", "bot", "webhook", "email", "proactive"]],
	];
	const everywhere: Where[] = ["chat", "grupo", "routine", "bot", "webhook", "email", "proactive", "subagent"];

	for (const [bot, globalDefault, onV2] of expected) {
		it(`bot ${bot} + padrão ${globalDefault}: v2 em [${onV2.join(", ") || "nenhuma origem"}]`, () => {
			const policy = readEnginePolicy(bots[bot]);
			for (const where of everywhere) {
				const picked = chooseRunEngine({ policy, globalDefault, ...run(where) });
				expect(picked, `${where}`).toBe(onV2.includes(where) ? "v2" : "v1");
			}
		});
	}

	it("o motor gravado no run vence tudo (retomada), nos dois sentidos", () => {
		for (const bot of Object.keys(bots) as Bot[]) {
			for (const globalDefault of ["off", "chat", "all"] as const) {
				for (const where of everywhere) {
					const policy = readEnginePolicy(bots[bot]);
					expect(chooseRunEngine({ stored: "v1", policy, globalDefault, ...run(where) })).toBe("v1");
					expect(chooseRunEngine({ stored: "v2", policy, globalDefault, ...run(where) })).toBe("v2");
				}
			}
		}
	});

	it("sem padrão informado vale o padrão novo (all): bot sem escolha vai ao v2 em todas as origens; v2 sem escopo é all, v2/chat e v1 explícito ficam como escolhidos", () => {
		expect(chooseRunEngine({ policy: readEnginePolicy({}), origin: "chat", isGroupRun: false })).toBe("v2");
		expect(chooseRunEngine({ policy: readEnginePolicy({}), origin: "routine", isGroupRun: false })).toBe("v2");
		expect(chooseRunEngine({ policy: readEnginePolicy({ engine: "v2" }), origin: "routine", isGroupRun: false })).toBe("v2");
		expect(chooseRunEngine({ policy: readEnginePolicy({ engine: "v2", engineScope: "chat" }), origin: "routine", isGroupRun: false })).toBe("v1");
		expect(chooseRunEngine({ policy: readEnginePolicy({ engine: "v1" }), origin: "chat", isGroupRun: false })).toBe("v1");
	});

	it("env ausente, vazio ou lixo (via readEngineDefault) equivale a all; off é a emergência e chat limita ao chat", () => {
		const where = [
			{ origin: "chat", isGroupRun: false },
			{ origin: "chat", isGroupRun: true },
			{ origin: "routine", isGroupRun: false },
			{ origin: "webhook", isGroupRun: false },
			{ origin: "email", isGroupRun: false },
			{ origin: "subagent", isGroupRun: false },
		];
		const policy = readEnginePolicy({});
		const engines = (raw: unknown) => where.map((w) => chooseRunEngine({ policy, globalDefault: readEngineDefault(raw), ...w }));
		const all = ["v2", "v2", "v2", "v2", "v2", "v1"];
		for (const raw of [undefined, "", "lixo", "all"]) expect(engines(raw), String(raw)).toEqual(all);
		expect(engines("off")).toEqual(["v1", "v1", "v1", "v1", "v1", "v1"]);
		// off vale também para quem escolheu o v2 (todos os bots); o motor já gravado no run segue.
		const chosen = readEnginePolicy({ engine: "v2", engineScope: "all" });
		for (const w of where) expect(chooseRunEngine({ policy: chosen, globalDefault: "off", ...w }), w.origin).toBe("v1");
		expect(chooseRunEngine({ stored: "v2", policy: chosen, globalDefault: "off", ...where[0]! })).toBe("v2");
		expect(engines("chat")).toEqual(["v2", "v1", "v1", "v1", "v1", "v1"]);
	});
});

describe("perfil do run (sem regex sobre o texto do pedido, decisão do dono de 03/11)", () => {
	it("o motor não exporta mais detectores de texto (looksLikeLongTask, isShortContinuation)", async () => {
		const module = (await import("./engine-policy.js")) as Record<string, unknown>;
		expect("looksLikeLongTask" in module).toBe(false);
		expect("isShortContinuation" in module).toBe(false);
	});

	it("promoção automática grava long_work e a origem no budgetJson, preservando o resto", () => {
		const base = { humanTurn: true, contextLength: 1000, engine: "v2", engineProfile: "chat" };
		const promoted = withRunPromotion(base);
		expect(promoted).toEqual({ humanTurn: true, contextLength: 1000, engine: "v2", engineProfile: "long_work", promotedFrom: "chat" });
		expect(readRunProfile(promoted)).toBe("long_work");
		expect(readRunPromotedFrom(promoted)).toBe("chat");
		expect(readRunPromotedFrom(base)).toBeUndefined();
		expect(readRunPromotedFrom(null)).toBeUndefined();
	});

	it("a política do bot força o perfil; em auto o run nasce em chat, qualquer que seja o pedido", () => {
		expect(resolveRunProfile({ policy: readEnginePolicy({ workProfile: "chat" }) })).toBe("chat");
		expect(resolveRunProfile({ policy: readEnginePolicy({ workProfile: "long_work" }) })).toBe("long_work");
		// Pedido de relatório, de pesquisa em várias fontes ou "Bom dia": nenhum muda o perfil de partida.
		expect(resolveRunProfile({ policy: readEnginePolicy({}) })).toBe("chat");
	});
});

describe("tetos do run gravados no budgetJson (valor e origem)", () => {
	it("withRunCaps/readRunCaps: o teto de passos guarda valor e, só se veio do dono, a origem", () => {
		expect(readRunCaps(withRunCaps({}, { steps: 80, stepsSource: "bot" }))).toEqual({ steps: 80, stepsSource: "bot" });
		expect(readRunCaps(withRunCaps({}, { steps: 200 }))).toEqual({ steps: 200 });
		expect(readRunCaps({ caps: { steps: 50, stepsSource: "servidor" } })).toEqual({ steps: 50 });
		expect(readRunCaps({ caps: { steps: 0 } })).toEqual({});
	});

	it("withRunCaps/readRunCaps: guardam só tetos positivos e finitos, com origem válida, preservando o resto", () => {
		const budget = withRunCaps({ humanTurn: true }, { costUsd: 0.25, costSource: "server", wallMs: 20 * 60_000, wallSource: "bot" });
		expect(budget).toEqual({ humanTurn: true, caps: { costUsd: 0.25, costSource: "server", wallMs: 1_200_000, wallSource: "bot" } });
		expect(readRunCaps(budget)).toEqual({ costUsd: 0.25, costSource: "server", wallMs: 1_200_000, wallSource: "bot" });
		// Sem teto: nada é gravado.
		expect(withRunCaps({ a: 1 }, {})).toEqual({ a: 1 });
		expect(withRunCaps(null, { costUsd: 0, wallMs: Number.NaN })).toEqual({});
		// Origem inventada ou lixo no JSON não vira texto para o usuário.
		expect(readRunCaps({ caps: { costUsd: 0.5, costSource: "hacker", wallMs: -1 } })).toEqual({ costUsd: 0.5 });
		expect(readRunCaps(null)).toEqual({});
	});
});

describe("motor v4 atrás de flag por conta (F1.12)", () => {
	const gateOn = readEngineV4Gate("true", "u1, u2 ,u1");
	const botsV4: unknown[] = [{}, { engine: "v1" }, { engine: "v2" }, { engine: "v2", engineScope: "chat" }];
	const origins = ["chat", "routine", "bot", "webhook", "email", "proactive", "subagent"];
	const cases = botsV4.flatMap((bot) => origins.flatMap((origin) => [false, true].map((isGroupRun) => ({ bot, origin, isGroupRun }))));

	it("lê a flag: só valor afirmativo liga; contas em lista sem duplicata, vazios nem 'default'", () => {
		expect(gateOn).toEqual({ enabled: true, accounts: ["u1", "u2"] });
		for (const flag of [undefined, "", "0", "false", "off", "tru", "ligado", 1, null]) expect(readEngineV4Gate(flag, "u1").enabled, String(flag)).toBe(false);
		for (const flag of ["1", "true", "TRUE", " on ", "yes"]) expect(readEngineV4Gate(flag, "u1").enabled, flag).toBe(true);
		expect(readEngineV4Gate("1", " , default,,").accounts).toEqual([]);
		expect(readEngineV4Gate("1", undefined).accounts).toEqual([]);
		expect(ENGINE_V4_OFF).toEqual({ enabled: false, accounts: [] });
	});

	it("v4 só com a flag ligada E a conta na lista (id exato), no chat direto", () => {
		const policy = readEnginePolicy({});
		const base = { policy, origin: "chat", isGroupRun: false };
		expect(chooseRunEngine({ ...base, userId: "u1", v4Gate: gateOn })).toBe("v4");
		expect(chooseRunEngine({ ...base, userId: "u2", v4Gate: gateOn })).toBe("v4");
		expect(chooseRunEngine({ ...base, userId: "u3", v4Gate: gateOn })).toBe("v2");
		expect(chooseRunEngine({ ...base, userId: "u", v4Gate: gateOn })).toBe("v2");
		expect(chooseRunEngine({ ...base, userId: "u1", v4Gate: readEngineV4Gate("false", "u1") })).toBe("v2");
		expect(chooseRunEngine({ ...base, userId: "u1", v4Gate: readEngineV4Gate("true", "") })).toBe("v2");
		expect(chooseRunEngine({ ...base, v4Gate: gateOn })).toBe("v2");
		expect(chooseRunEngine({ ...base, userId: "default", v4Gate: readEngineV4Gate("true", "default") })).toBe("v2");
	});

	it("run acordado pela agenda (proativo com item ligado ao run) vai ao v4; proativo comum não, nem agenda em grupo ou subagente", () => {
		const base = { policy: readEnginePolicy({}), origin: "proactive", isGroupRun: false, userId: "u1", v4Gate: gateOn };
		expect(chooseRunEngine({ ...base, agenda: true })).toBe("v4");
		expect(chooseRunEngine(base)).not.toBe("v4");
		expect(chooseRunEngine({ ...base, agenda: true, userId: "u3" })).not.toBe("v4");
		expect(chooseRunEngine({ ...base, agenda: true, v4Gate: ENGINE_V4_OFF })).not.toBe("v4");
		expect(chooseRunEngine({ ...base, agenda: true, isGroupRun: true })).not.toBe("v4");
		expect(chooseRunEngine({ ...base, agenda: true, isSubagent: true })).not.toBe("v4");
		expect(chooseRunEngine({ ...base, origin: "routine", agenda: true })).not.toBe("v4");
		expect(chooseRunEngine({ ...base, policy: readEnginePolicy({ engine: "v1" }), agenda: true })).toBe("v1");
		// o v4 gravado no run de agenda segue; se a flag cai, recomeça no motor padrão
		expect(chooseRunEngine({ ...base, agenda: true, stored: "v4" })).toBe("v4");
		expect(chooseRunEngine({ ...base, agenda: true, stored: "v4", v4Gate: ENGINE_V4_OFF })).not.toBe("v4");
	});

	it("v4 não atende rotina, bot→bot, proativo, webhook, e-mail, grupo nem subagente, e v1 explícito do bot vence a flag", () => {
		for (const origin of ["routine", "bot", "webhook", "email", "proactive", "subagent"]) {
			expect(chooseRunEngine({ policy: readEnginePolicy({}), origin, isGroupRun: false, userId: "u1", v4Gate: gateOn }), origin).not.toBe("v4");
		}
		expect(chooseRunEngine({ policy: readEnginePolicy({}), origin: "chat", isGroupRun: true, userId: "u1", v4Gate: gateOn })).toBe("v2");
		expect(chooseRunEngine({ policy: readEnginePolicy({}), origin: "chat", isGroupRun: false, isSubagent: true, userId: "u1", v4Gate: gateOn })).not.toBe("v4");
		expect(chooseRunEngine({ policy: readEnginePolicy({ engine: "v1" }), origin: "chat", isGroupRun: false, userId: "u1", v4Gate: gateOn })).toBe("v1");
	});

	it("regressão: com a flag desligada ou a conta fora da lista, TODA decisão v1/v2 é idêntica à de antes", () => {
		for (const globalDefault of ["off", "chat", "all", undefined] as const) {
			for (const { bot, origin, isGroupRun } of cases) {
				const policy = readEnginePolicy(bot);
				const before = chooseRunEngine({ policy, origin, isGroupRun, globalDefault });
				for (const gate of [undefined, ENGINE_V4_OFF, readEngineV4Gate("false", "u1"), readEngineV4Gate("true", "outra-conta"), readEngineV4Gate("true", "")]) {
					const picked = chooseRunEngine({ policy, origin, isGroupRun, globalDefault, userId: "u1", v4Gate: gate });
					expect(picked, JSON.stringify({ bot, origin, isGroupRun, globalDefault })).toBe(before);
					expect(["v1", "v2"]).toContain(picked);
				}
			}
		}
	});

	it("motor gravado: v1 e v2 seguem como estão; v4 gravado só segue com a flag ligada para a conta (senão recomeça no motor padrão do bot)", () => {
		const base = { policy: readEnginePolicy({}), origin: "chat", isGroupRun: false };
		expect(readRunEngine({ engine: "v4" })).toBe("v4");
		expect(readRunEngine({ engine: "v3" })).toBeUndefined();
		for (const gate of [undefined, gateOn]) {
			expect(chooseRunEngine({ ...base, stored: "v1", userId: "u1", v4Gate: gate })).toBe("v1");
			expect(chooseRunEngine({ ...base, stored: "v2", userId: "u1", v4Gate: gate })).toBe("v2");
		}
		expect(chooseRunEngine({ ...base, stored: "v4", userId: "u1", v4Gate: gateOn })).toBe("v4");
		expect(chooseRunEngine({ ...base, stored: "v4", userId: "u1", v4Gate: ENGINE_V4_OFF })).toBe("v2");
		expect(chooseRunEngine({ ...base, stored: "v4", userId: "u3", v4Gate: gateOn })).toBe("v2");
		expect(chooseRunEngine({ ...base, stored: "v4" })).toBe("v2");
		// B13: o v4 gravado também revalida a origem, mesmo com a flag ligada para a conta
		for (const origin of ["routine", "bot", "proactive", "webhook", "email", "subagent"]) {
			expect(chooseRunEngine({ ...base, stored: "v4", origin, userId: "u1", v4Gate: gateOn }), origin).not.toBe("v4");
		}
		expect(chooseRunEngine({ ...base, stored: "v4", isGroupRun: true, userId: "u1", v4Gate: gateOn })).toBe("v2");
		expect(chooseRunEngine({ ...base, stored: "v4", isSubagent: true, userId: "u1", v4Gate: gateOn })).not.toBe("v4");
		expect(chooseRunEngine({ ...base, policy: readEnginePolicy({ engine: "v1" }), stored: "v4", isGroupRun: true, userId: "u1", v4Gate: gateOn })).toBe("v1");
		expect(chooseRunEngine({ ...base, policy: readEnginePolicy({ engine: "v1" }), stored: "v4" })).toBe("v1");
		expect(withRunEngine(null, { engine: "v4", profile: "chat" })).toEqual({ engine: "v4", engineProfile: "chat" });
	});
});
