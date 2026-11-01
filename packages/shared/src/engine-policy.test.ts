import { describe, expect, it } from "vitest";
import {
	chooseRunEngine,
	engineV2SupportsRun,
	looksLikeLongTask,
	readEnginePolicy,
	readRunEngine,
	readRunProfile,
	resolveRunProfile,
	withBotEngine,
	withRunEngine,
} from "./engine-policy.js";

describe("readEnginePolicy", () => {
	it("bot sem política usa v1, perfil automático e o orçamento do dono (US$ 0,50 e 20 min)", () => {
		for (const raw of [null, undefined, {}, [], "x", 3]) {
			expect(readEnginePolicy(raw)).toEqual({ engine: "v1", workProfile: "auto", longWorkBudgetUsd: 0.5, longWorkMinutes: 20 });
		}
	});

	it("lê v2 e os ajustes do bot", () => {
		expect(readEnginePolicy({ engine: "v2", workProfile: "long_work", longWorkBudgetUsd: 1.25, longWorkMinutes: 45 })).toEqual({
			engine: "v2",
			workProfile: "long_work",
			longWorkBudgetUsd: 1.25,
			longWorkMinutes: 45,
		});
	});

	it("valor inválido cai no padrão e número fora da faixa é limitado", () => {
		const policy = readEnginePolicy({ engine: "v3", workProfile: "turbo", longWorkBudgetUsd: "caro", longWorkMinutes: 9999 });
		expect(policy.engine).toBe("v1");
		expect(policy.workProfile).toBe("auto");
		expect(policy.longWorkBudgetUsd).toBe(0.5);
		expect(policy.longWorkMinutes).toBe(120);
		expect(readEnginePolicy({ longWorkBudgetUsd: -3 }).longWorkBudgetUsd).toBe(0.05);
	});

	it("withBotEngine liga e desliga sem perder as outras chaves", () => {
		const on = withBotEngine({ planMode: false }, "v2");
		expect(on).toEqual({ planMode: false, engine: "v2" });
		expect(withBotEngine(on, "v1")).toEqual({ planMode: false });
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

	it("bot sem política roda no v1; política v2 roda no v2 no chat", () => {
		expect(chooseRunEngine({ policy: v1, origin: "chat", isGroupRun: false })).toBe("v1");
		expect(chooseRunEngine({ policy: v2, origin: "chat", isGroupRun: false })).toBe("v2");
	});

	it("a retomada respeita o motor gravado, mesmo que o bot tenha mudado", () => {
		expect(chooseRunEngine({ stored: "v1", policy: v2, origin: "chat", isGroupRun: false })).toBe("v1");
		expect(chooseRunEngine({ stored: "v2", policy: v1, origin: "chat", isGroupRun: false })).toBe("v2");
	});

	it("rotina, webhook, proativo, grupo e subagente continuam no v1 nesta fase", () => {
		for (const origin of ["routine", "webhook", "proactive", "email", "bot", "subagent"]) {
			expect(chooseRunEngine({ policy: v2, origin, isGroupRun: false })).toBe("v1");
		}
		expect(chooseRunEngine({ policy: v2, origin: "chat", isGroupRun: true })).toBe("v1");
		expect(engineV2SupportsRun({ origin: "chat", isGroupRun: false, isSubagent: true })).toBe(false);
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
});
