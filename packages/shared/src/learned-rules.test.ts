import { describe, expect, it } from "vitest";
import { LEARNED_RULES_MAX, parseRulePatch, patchRuleInPolicy, readLearnedRules, removeRuleFromPolicy, ruleId, toPolicyRules } from "./learned-rules.js";

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
	it("a lista tem teto", () => {
		const many = Array.from({ length: LEARNED_RULES_MAX + 20 }, (_, i) => ({ match: `tool_${i}`, verdict: "run" }));
		expect(readLearnedRules({ rules: many })).toHaveLength(LEARNED_RULES_MAX);
	});
	it("o autorizador recebe só match, effect e verdict", () => {
		expect(toPolicyRules(policy)).toEqual([{ match: "gmail_send", effect: "send", verdict: "approve" }, { match: "web_*", verdict: "run" }]);
	});
});

describe("edição", () => {
	it("muda o veredito e a observação, mantém o resto da política", () => {
		const id = ruleId({ match: "gmail_send", effect: "send" });
		const out = patchRuleInPolicy(policy, id, { verdict: "deny", note: null })!;
		expect(out.rule).toMatchObject({ verdict: "deny", note: null, match: "gmail_send" });
		expect(out.policyJson.engine).toBe("v2");
		expect(readLearnedRules(out.policyJson).map((r) => r.verdict)).toEqual(["deny", "run"]);
		// Ler a política original de novo: a edição não muta o que veio.
		expect(readLearnedRules(policy)[0]!.verdict).toBe("approve");
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
