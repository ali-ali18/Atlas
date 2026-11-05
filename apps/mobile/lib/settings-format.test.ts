import { describe, expect, it } from "vitest";
import { ChatApiError } from "./chat-api";
import { AUTONOMY_OPTIONS, USAGE_PERIOD_OPTIONS, autonomySubtitle, barPercent, costLabel, formatUsd, friendlyError, runsLabel, tokensLabel, versionLabel } from "./settings-format";

describe("custo", () => {
	it("dólar com vírgula; frações de centavo ganham mais casas", () => {
		expect(formatUsd(12.345)).toBe("US$ 12,35");
		expect(formatUsd(1)).toBe("US$ 1,00");
		expect(formatUsd(0.0042)).toBe("US$ 0,0042");
		expect(formatUsd(0)).toBe("US$ 0,0000");
	});
	it("sem custo informado: traço, ou Plano quando só houve chamadas do plano", () => {
		expect(costLabel({ costUsd: null, costUnknownCalls: 0, planCalls: 0 })).toBe("—");
		expect(costLabel({ costUsd: null, costUnknownCalls: 2, planCalls: 4 })).toBe("Plano");
	});
	it("custo parcial é dito", () => {
		expect(costLabel({ costUsd: 2, costUnknownCalls: 1, planCalls: 0 })).toBe("US$ 2,00 (parcial)");
		expect(costLabel({ costUsd: 2, costUnknownCalls: 0, planCalls: 0 })).toBe("US$ 2,00");
	});
});

describe("tokens e execuções", () => {
	it("compacta em mil e mi", () => {
		expect(tokensLabel(0)).toBe("0");
		expect(tokensLabel(999)).toBe("999");
		expect(tokensLabel(1200)).toBe("1,2 mil");
		expect(tokensLabel(2000)).toBe("2 mil");
		expect(tokensLabel(3_450_000)).toBe("3,5 mi");
		expect(tokensLabel(-5)).toBe("0");
		expect(tokensLabel(Number.NaN)).toBe("0");
	});
	it("singular e plural", () => {
		expect(runsLabel(1)).toBe("1 execução");
		expect(runsLabel(0)).toBe("0 execuções");
		expect(runsLabel(12)).toBe("12 execuções");
	});
});

describe("barPercent", () => {
	const rows = [
		{ costUsd: 4, runs: 1 },
		{ costUsd: 1, runs: 9 },
	];
	it("proporcional ao maior custo", () => {
		expect(barPercent(rows[0]!, rows)).toBe(100);
		expect(barPercent(rows[1]!, rows)).toBe(25);
	});
	it("sem custo nenhum, por execuções; lista vazia dá 0", () => {
		const plan = [
			{ costUsd: null, runs: 10 },
			{ costUsd: null, runs: 5 },
		];
		expect(barPercent(plan[1]!, plan)).toBe(50);
		expect(barPercent({ costUsd: null, runs: 0 }, [{ costUsd: null, runs: 0 }])).toBe(0);
	});
});

describe("rótulos", () => {
	it("períodos na ordem do servidor", () => {
		expect(USAGE_PERIOD_OPTIONS.map((option) => option.value)).toEqual(["today", "7d", "30d"]);
		expect(USAGE_PERIOD_OPTIONS.map((option) => option.label)).toEqual(["Hoje", "7 dias", "30 dias"]);
	});
	it("níveis de permissão com o texto do produto", () => {
		expect(AUTONOMY_OPTIONS.map((option) => option.value)).toEqual(["autonomous", "balanced", "always_ask"]);
		expect(AUTONOMY_OPTIONS[1]?.label).toBe("Equilibrado");
		expect(autonomySubtitle("always_ask")).toBe("Sempre perguntar");
		expect(autonomySubtitle(null)).toBe("Carregando…");
	});
	it("versão com id curto da atualização", () => {
		expect(versionLabel("0.0.1", "a1b2c3d4-e5f6")).toBe("0.0.1 (a1b2c3d)");
		expect(versionLabel("0.0.1", null)).toBe("0.0.1");
		expect(versionLabel(null, undefined)).toBe("");
	});
});

describe("friendlyError", () => {
	it("sem rede", () => {
		expect(friendlyError(new TypeError("Network request failed"))).toBe("Sem conexão. Não consegui salvar agora.");
		expect(friendlyError(new TypeError("x"), "load")).toBe("Sem conexão. Não consegui carregar agora.");
	});
	it("sessão caída", () => {
		expect(friendlyError(new ChatApiError("Unauthorized", 401))).toBe("Sua sessão expirou. Entre de novo.");
	});
	it("mensagem do servidor só quando ele escreveu e não foi erro dele", () => {
		expect(friendlyError(new ChatApiError("O nome não pode ficar vazio.", 400, true))).toBe("O nome não pode ficar vazio.");
		expect(friendlyError(new ChatApiError("Failed to update settings", 503, true))).toBe("Não consegui salvar agora. Tente de novo.");
		expect(friendlyError(new ChatApiError("Bad Gateway", 502))).toBe("Não consegui salvar agora. Tente de novo.");
	});
});
