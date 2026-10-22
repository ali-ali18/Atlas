import { describe, expect, it } from "vitest";
import { isArgPresent, lessonProvenanceProblem, parseLessonDeltas, parseLessonRule, readArgPath, readLessonRule, toolPatternMatches } from "./index.js";

const required = { kind: "required_args", tool: "mcp__erp__create_proposal", fields: ["customer.id", "payment_method"], note: "sem forma de pagamento a proposta falha" };

describe("regras das licoes: formato estrito (so apertam)", () => {
	it("aceita os 3 tipos e normaliza", () => {
		expect(parseLessonRule(required)).toEqual({ ok: true, rule: required });
		expect(parseLessonRule({ kind: "require_prior_call", tool: "mcp__erp__create_proposal", requires: "mcp__erp__list_payment_methods", within: "run" })).toMatchObject({ ok: true });
		expect(parseLessonRule({ kind: "confirm_always", tool: "mcp__erp__*" })).toMatchObject({ ok: true });
	});

	it("recusa o que relaxaria aprovacoes, trocaria destino ou pularia checagem", () => {
		const bad: unknown[] = [
			{ kind: "auto_approve", tool: "mcp__erp__create_proposal" },
			{ kind: "skip_confirmation", tool: "mcp__erp__create_proposal" },
			{ kind: "set_arg", tool: "mcp__erp__send", field: "to", value: "a@b.co" },
			{ kind: "confirm_always", tool: "mcp__erp__create_proposal", mode: "never" },
			{ kind: "required_args", tool: "mcp__erp__send", fields: ["to"], default: "x@y.co" },
			{ kind: "require_prior_call", tool: "a_tool", requires: "a_tool", within: "run" },
			{ kind: "require_prior_call", tool: "a_tool", requires: "b_tool", within: "conversation" },
			{ kind: "required_args", tool: "***", fields: ["x"] },
			{ kind: "required_args", tool: "mcp__erp__send", fields: [] },
			{ kind: "required_args", tool: "mcp__erp__send", fields: ["a b"] },
			"confirm_always",
			null,
		];
		for (const rule of bad) expect(parseLessonRule(rule).ok, JSON.stringify(rule)).toBe(false);
	});

	it("a nota vinda do refletor nao leva e-mail/URL/telefone; a do dono pode", () => {
		const withMail = { ...required, note: "mande para joao@empresa.com" };
		expect(parseLessonRule(withMail).ok).toBe(false);
		expect(parseLessonRule(withMail, { userAuthored: true }).ok).toBe(true);
	});

	it("leitura tolerante da coluna: regra invalida vira sem regra", () => {
		expect(readLessonRule(required)).toEqual(required);
		expect(readLessonRule({ kind: "auto_approve", tool: "x_tool" })).toBeNull();
		expect(readLessonRule(null)).toBeNull();
	});

	it("casa pelo nome exposto ou original, com * opcional", () => {
		expect(toolPatternMatches("mcp__erp__create_proposal", "mcp__erp__create_proposal")).toBe(true);
		expect(toolPatternMatches("create_proposal", "mcp__erp__create_proposal", "create_proposal")).toBe(true);
		expect(toolPatternMatches("mcp__erp__create*", "mcp__erp__create_proposal")).toBe(true);
		expect(toolPatternMatches("mcp__erp__create*", "mcp__crm__create_proposal")).toBe(false);
		expect(toolPatternMatches("mcp__erp__a.b", "mcp__erp__aXb")).toBe(false);
	});

	it("caminhos e preenchimento de argumentos", () => {
		expect(readArgPath({ customer: { id: 7 } }, "customer.id")).toBe(7);
		expect(readArgPath({ customer: null }, "customer.id")).toBeUndefined();
		expect(isArgPresent(0)).toBe(true);
		expect(isArgPresent(false)).toBe(true);
		expect(isArgPresent("  ")).toBe(false);
		expect(isArgPresent([])).toBe(false);
		expect(isArgPresent(undefined)).toBe(false);
	});
});

describe("regra vinda do refletor: proveniencia", () => {
	const slice = {
		userTexts: ["Voce precisa sempre informar a forma de pagamento ao criar proposta"],
		failureTexts: ["payment_method is required"],
		toolNames: ["mcp__erp__create_proposal"],
	};
	const evidence = { source: "user" as const, quote: "sempre informar a forma de pagamento" };
	const lesson = { content: "Ao criar proposta, informe a forma de pagamento — porque o ERP exige", evidence, rule: required as never };

	it("passa com citacao do usuario e tool que apareceu no trecho", () => {
		expect(lessonProvenanceProblem(lesson, slice)).toBeNull();
	});

	it("recusa regra para tool que nao apareceu, sem origem ou invalida", () => {
		expect(lessonProvenanceProblem({ ...lesson, rule: { ...required, tool: "mcp__crm__delete_all" } as never }, slice)).toMatch(/não apareceu/);
		expect(lessonProvenanceProblem({ ...lesson, evidence: { quote: evidence.quote } as never }, slice)).not.toBeNull();
		expect(lessonProvenanceProblem({ ...lesson, rule: { kind: "auto_approve", tool: "mcp__erp__create_proposal" } as never }, slice)).toMatch(/regra recusada/);
	});

	it("regra com dado concreto que o usuario nao escreveu e recusada", () => {
		const leaky = { ...required, note: "enviar para fulano@x.com" };
		expect(lessonProvenanceProblem({ ...lesson, rule: leaky as never }, slice)).toMatch(/regra/);
	});

	it("o delta add com regra e lido; regra invalida descarta a licao inteira", () => {
		const delta = (rule: unknown) => JSON.stringify({ deltas: [{ op: "add", scope: "tool", scopeKey: "mcp__erp__create_proposal", content: "Ao criar proposta, informe o pagamento — porque falha", origin: "correction", evidence, rule }] });
		const ok = parseLessonDeltas(delta(required));
		expect(ok.deltas).toHaveLength(1);
		expect(ok.deltas[0]).toMatchObject({ op: "add", rule: required });
		const bad = parseLessonDeltas(delta({ kind: "auto_approve", tool: "mcp__erp__create_proposal" }));
		expect(bad.deltas).toHaveLength(0);
		expect(bad.ignored).toBe(1);
		expect(parseLessonDeltas(delta(undefined)).deltas[0]).not.toHaveProperty("rule");
	});
});
