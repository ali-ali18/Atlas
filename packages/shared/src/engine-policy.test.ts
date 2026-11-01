import { describe, expect, it } from "vitest";
import {
	ENGINE_DEFAULT_SCOPE,
	chooseRunEngine,
	engineV2SupportsRun,
	readEngineDefault,
	resolveBotEngineRouting,
	type EngineDefault,
	looksLikeLongTask,
	readEnginePolicy,
	readRunEngine,
	readRunProfile,
	resolveRunProfile,
	withBotEngine,
	withRunEngine,
} from "./engine-policy.js";

describe("readEnginePolicy", () => {
	it("bot sem política usa o motor novo (padrão) em todas as origens, perfil automático, sem limite de gasto e 60 min de tempo máximo", () => {
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

describe("perfil do run", () => {
	it("conversa curta não é tarefa", () => {
		for (const text of ["Bom dia", "oi, tudo bem?", "qual o dólar hoje?", "obrigado!"]) {
			expect(looksLikeLongTask(text), text).toBe(false);
		}
	});

	it("pesquisa e relatório são trabalho longo", () => {
		expect(looksLikeLongTask("Faça uma pesquisa de mercado sobre o setor de café especial no Brasil e monte um relatório")).toBe(true);
		expect(looksLikeLongTask("Research the market for specialty coffee and prepare a report with sources")).toBe(true);
	});

	it("a política do bot força o perfil; auto decide pelo pedido", () => {
		const text = "Levante os concorrentes e monte um comparativo com preços";
		expect(resolveRunProfile({ policy: readEnginePolicy({ workProfile: "chat" }), text })).toBe("chat");
		expect(resolveRunProfile({ policy: readEnginePolicy({ workProfile: "long_work" }), text: "oi" })).toBe("long_work");
		expect(resolveRunProfile({ policy: readEnginePolicy({}), text })).toBe("long_work");
		expect(resolveRunProfile({ policy: readEnginePolicy({}), text: "Bom dia" })).toBe("chat");
	});

	it("e-mail recebido e webhook não escolhem o perfil caro pelo texto; o dono ainda pode forçá-lo", () => {
		const text = "Levante os concorrentes e monte um comparativo com preços";
		expect(resolveRunProfile({ policy: readEnginePolicy({}), text, origin: "email" })).toBe("chat");
		expect(resolveRunProfile({ policy: readEnginePolicy({}), text, origin: "webhook" })).toBe("chat");
		expect(resolveRunProfile({ policy: readEnginePolicy({ workProfile: "long_work" }), text: "oi", origin: "webhook" })).toBe("long_work");
		expect(resolveRunProfile({ policy: readEnginePolicy({ workProfile: "long_work" }), text: "oi", origin: "email" })).toBe("long_work");
	});
});
