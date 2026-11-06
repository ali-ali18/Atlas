import { describe, expect, it } from "vitest";
import { EXAMPLE_ROLE_CHAINS, pickModelFor } from "./pick-model.js";
import type { ProviderHealth, SpendCeilings } from "./types.js";

const now = 1_000_000;
const ok: ProviderHealth = {};

describe("pickModelFor", () => {
	it("escolhe a primeira entrada saudável", () => {
		const r = pickModelFor("main", EXAMPLE_ROLE_CHAINS, ok, {}, now);
		expect(r).toEqual({ entry: { provider: "anthropic", model: "claude-sonnet-5-5" }, skipped: [] });
	});

	it("pula provedor em cooldown de 429 e informa o motivo", () => {
		const r = pickModelFor("main", EXAMPLE_ROLE_CHAINS, { anthropic: { until: now + 5000, reason: "rate_limit" } }, {}, now);
		expect("entry" in r && r.entry.provider).toBe("openrouter");
		expect("skipped" in r && r.skipped[0]?.reason).toBe("rate_limit");
	});

	it("cooldown vencido volta a valer", () => {
		const r = pickModelFor("main", EXAMPLE_ROLE_CHAINS, { anthropic: { until: now, reason: "rate_limit" } }, {}, now);
		expect("entry" in r && r.entry.provider).toBe("anthropic");
	});

	it("pula provedor sem cota", () => {
		const r = pickModelFor("helper", EXAMPLE_ROLE_CHAINS, { anthropic: { until: now + 1, reason: "quota" } }, {}, now);
		expect("entry" in r && r.entry).toEqual({ provider: "opencode-go", model: "claude-haiku-5-5" });
		expect("skipped" in r && r.skipped[0]?.reason).toBe("quota");
	});

	it("tudo fora do ar devolve none com os pulados", () => {
		const health: ProviderHealth = {
			anthropic: { until: now + 1, reason: "down" },
			openrouter: { until: now + 1, reason: "rate_limit" },
			"opencode-go": { until: now + 1, reason: "quota" },
		};
		const r = pickModelFor("main", EXAMPLE_ROLE_CHAINS, health, {}, now);
		expect("none" in r && r.none.kind).toBe("all_unavailable");
		if ("none" in r && r.none.kind === "all_unavailable") expect(r.none.skipped).toHaveLength(3);
	});

	it("teto atingido para com nome, valor e origem", () => {
		const ceilings: SpendCeilings = { account: { month: 50 }, bot: { day: 5 } };
		const r = pickModelFor("main", EXAMPLE_ROLE_CHAINS, ok, { bot: { day: 5.2 }, account: { month: 10 } }, now, ceilings);
		expect(r).toEqual({ none: { kind: "ceiling", period: "day", source: "bot", limitUsd: 5, spentUsd: 5.2 } });
	});

	it("sem teto configurado, gasto alto nunca bloqueia", () => {
		const r = pickModelFor("main", EXAMPLE_ROLE_CHAINS, ok, { account: { month: 9999 } }, now);
		expect("entry" in r).toBe(true);
	});

	it("gasto abaixo do teto segue", () => {
		const r = pickModelFor("main", EXAMPLE_ROLE_CHAINS, ok, { account: { week: 1 } }, now, { account: { week: 2 } });
		expect("entry" in r).toBe(true);
	});

	it("cadeia vazia", () => {
		const r = pickModelFor("main", { ...EXAMPLE_ROLE_CHAINS, main: [] }, ok, {}, now);
		expect(r).toEqual({ none: { kind: "no_chain" } });
	});

	it("exemplo: code começa no opus e cai na cadeia main; vision usa main", () => {
		expect(EXAMPLE_ROLE_CHAINS.code[0]?.model).toBe("claude-opus-5-5");
		expect(EXAMPLE_ROLE_CHAINS.code.slice(1)).toEqual(EXAMPLE_ROLE_CHAINS.main);
		expect(EXAMPLE_ROLE_CHAINS.vision).toEqual(EXAMPLE_ROLE_CHAINS.main);
	});
});
