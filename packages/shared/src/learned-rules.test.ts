import { describe, expect, it } from "vitest";
import { LEARNED_RULES_MAX, parseRulePatch, patchRuleInPolicy, readLearnedRules, removeRuleFromPolicy, ruleId, rulesCeilingError, toPolicyRules } from "./learned-rules.js";

const policy = {
	engine: "v2",
	rules: [
		{ match: "gmail_send", effect: "send", verdict: "approve", note: "sempre me pergunte", source: "learned", learnedAt: "2026-11-01T10:00:00Z" },
		{ match: "web_*", verdict: "run" },
		{ match: "", verdict: "run" },
		{ match: "x", verdict: "talvez" },
		"lixo",
	],
};

describe("leitura", () => {
	it("lê só as válidas, com id estável e padrões", () => {
		const rules = readLearnedRules(policy);
		expect(rules.map((r) => [r.match, r.effect, r.verdict, r.source])).toEqual([["gmail_send", "send", "approve", "learned"], ["web_*", null, "run", "owner"]]);
		expect(rules[0]!.id).toBe(ruleId({ match: "gmail_send", effect: "send" }));
		expect(ruleId({ match: "web_*" })).not.toBe(ruleId({ match: "web_*", effect: "read" }));
	});
	it("política sem regras, nula ou torta dá lista vazia", () => {
		expect(readLearnedRules(null)).toEqual([]);
		expect(readLearnedRules({ rules: "x" })).toEqual([]);
		expect(readLearnedRules([])).toEqual([]);
	});
	it("duas regras para o mesmo alvo viram uma (vale a última)", () => {
		const rules = readLearnedRules({ rules: [{ match: "a", verdict: "run" }, { match: "a", verdict: "deny" }] });
		expect(rules).toHaveLength(1);
		expect(rules[0]!.verdict).toBe("deny");
	});
	it("a leitura nunca corta regra válida por teto: uma deny antiga continua valendo (auditoria F5, S2)", () => {
		const many = [{ match: "gmail_send", verdict: "deny" }, ...Array.from({ length: LEARNED_RULES_MAX + 20 }, (_, i) => ({ match: `tool_${i}`, verdict: "run" }))];
		const rules = readLearnedRules({ rules: many });
		expect(rules).toHaveLength(LEARNED_RULES_MAX + 21);
		expect(toPolicyRules({ rules: many })[0]).toEqual({ match: "gmail_send", verdict: "deny" });
	});
	it("campo decorativo estragado não tira a regra de vigor; efeito desconhecido nega mais (deny) ou descarta (run/approve)", () => {
		const deny = { match: "gmail_send", verdict: "deny", note: "x".repeat(500), source: "alguem", learnedAt: 12 };
		expect(readLearnedRules({ rules: [deny] })[0]).toMatchObject({ verdict: "deny", note: null, source: "owner", learnedAt: null });
		expect(toPolicyRules({ rules: [{ match: "a", verdict: "deny", effect: "inventado" }] })).toEqual([{ match: "a", verdict: "deny" }]);
		expect(toPolicyRules({ rules: [{ match: "a", verdict: "run", effect: "inventado" }, { match: "b", verdict: "approve", effect: "inventado" }] })).toEqual([]);
		expect(toPolicyRules({ rules: [{ match: "m".repeat(300), verdict: "deny" }] })).toHaveLength(1);
	});
	it("recusa escrever acima do teto, em vez de cortar", () => {
		expect(rulesCeilingError(LEARNED_RULES_MAX)).toBeNull();
		expect(rulesCeilingError(LEARNED_RULES_MAX + 1)).toMatch(/máximo é 100/);
		const many = Array.from({ length: LEARNED_RULES_MAX + 1 }, (_, i) => ({ match: `tool_${i}`, verdict: "run" }));
		expect(patchRuleInPolicy({ rules: many }, ruleId({ match: "tool_0" }), { verdict: "deny" })).toEqual({ refused: expect.stringMatching(/máximo/) });
		// apagar sempre pode: é o caminho para voltar ao teto
		expect(removeRuleFromPolicy({ rules: many }, ruleId({ match: "tool_0" }))).not.toBeNull();
	});
	it("o autorizador recebe só match, effect e verdict", () => {
		expect(toPolicyRules(policy)).toEqual([{ match: "gmail_send", effect: "send", verdict: "approve" }, { match: "web_*", verdict: "run" }]);
	});
});

describe("edição", () => {
	it("muda o veredito e a observação, mantém o resto da política", () => {
		const id = ruleId({ match: "gmail_send", effect: "send" });
		const out = patchRuleInPolicy(policy, id, { verdict: "deny", note: null }) as NonNullable<Extract<ReturnType<typeof patchRuleInPolicy>, { rule: unknown }>>;
		expect(out.rule).toMatchObject({ verdict: "deny", note: null, match: "gmail_send" });
		expect(out.policyJson.engine).toBe("v2");
		expect(readLearnedRules(out.policyJson).map((r) => r.verdict)).toEqual(["deny", "run"]);
		// Ler a política original de novo: a edição não muta o que veio.
		expect(readLearnedRules(policy)[0]!.verdict).toBe("approve");
	});
	it("editar ou apagar UMA regra deixa as outras exatamente como estão guardadas (auditoria F5, S2b)", () => {
		const rules = [
			{ match: "a", verdict: "deny", futuro: { x: 1 }, note: "n", effect: "inventado" },
			{ match: "b", effect: "send", verdict: "run", note: "x".repeat(500), extra: true },
			{ match: "lixo-valido", verdict: "approve", source: "alguem" },
			"item-torto",
			{ match: "", verdict: "run" },
		];
		const id = ruleId({ match: "lixo-valido" });
		const patched = patchRuleInPolicy({ keep: 1, rules }, id, { verdict: "run", note: "ok" }) as { policyJson: { rules: unknown[]; keep: number } };
		expect(patched.policyJson.rules).toEqual([rules[0], rules[1], { match: "lixo-valido", verdict: "run", source: "alguem", note: "ok" }, "item-torto", rules[4]]);
		expect(patched.policyJson.keep).toBe(1);
		const removed = removeRuleFromPolicy({ rules }, id) as { policyJson: { rules: unknown[] } };
		expect(removed.policyJson.rules).toEqual([rules[0], rules[1], "item-torto", rules[4]]);
	});
	it("regra inexistente devolve null", () => {
		expect(patchRuleInPolicy(policy, "rule_00000000", { verdict: "run" })).toBeNull();
		expect(removeRuleFromPolicy(policy, "rule_00000000")).toBeNull();
	});
	it("apagar tira só a escolhida", () => {
		const out = removeRuleFromPolicy(policy, ruleId({ match: "web_*" }))!;
		expect(readLearnedRules(out.policyJson).map((r) => r.match)).toEqual(["gmail_send"]);
		expect(out.policyJson.engine).toBe("v2");
	});
	it("o corpo da edição é estrito", () => {
		expect(parseRulePatch({ verdict: "approve" }).ok).toBe(true);
		expect(parseRulePatch({}).ok).toBe(false);
		expect(parseRulePatch({ verdict: "tudo" }).ok).toBe(false);
		expect(parseRulePatch({ match: "outro" })).toEqual({ ok: false, error: "Campo desconhecido: match." });
	});
});
