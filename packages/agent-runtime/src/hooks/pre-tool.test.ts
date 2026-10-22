import { describe, expect, it } from "vitest";
import type { LessonRule } from "@workspace/shared";
import { isNativeWriteTool, runPreToolHooks, type HookLesson, type PreToolCall, type PreToolState } from "./pre-tool.js";

const call = (over: Partial<PreToolCall> = {}): PreToolCall => ({
	name: "mcp__erp__create_proposal",
	originalName: "create_proposal",
	connectorKey: "mcp:conn-erp",
	args: { customer: { id: 7 }, payment_method: "pix" },
	isMcp: true,
	isWrite: true,
	parameters: { properties: { customer: {}, payment_method: {} } },
	...over,
});

const lesson = (rule: LessonRule, over: Partial<HookLesson> = {}): HookLesson => ({ id: "cl0000lesson1abc", scope: "bot", scopeKey: null, rule, ...over });
const state = (over: Partial<PreToolState> = {}): PreToolState => ({ lessons: [], succeeded: new Set(), planPending: false, isToolAvailable: () => true, ...over });

describe("portao do plano pendente", () => {
	it("barra escritas com o texto do plano e deixa leituras passarem", () => {
		const blocked = runPreToolHooks(call(), state({ planPending: true }));
		expect(blocked.error).toContain("plano aguardando aprovação");
		expect(blocked.hits).toEqual([{ source: "plan", action: "blocked", tool: "mcp__erp__create_proposal" }]);
		expect(runPreToolHooks(call({ isWrite: false }), state({ planPending: true })).error).toBeUndefined();
		expect(runPreToolHooks(call(), state({ planPending: false })).error).toBeUndefined();
	});

	it("tools nativas que enviam algo para fora contam como escrita", () => {
		expect(isNativeWriteTool("email_send")).toBe(true);
		expect(isNativeWriteTool("web_search")).toBe(false);
	});
});

describe("required_args", () => {
	const rule: LessonRule = { kind: "required_args", tool: "mcp__erp__create_proposal", fields: ["customer.id", "payment_method"], note: "o ERP recusa sem pagamento" };

	it("campo ausente: erro com o id da licao, os campos e a nota", () => {
		const out = runPreToolHooks(call({ args: { customer: { id: 7 } } }), state({ lessons: [lesson(rule)] }));
		expect(out.error).toContain("Regra da lição [L1abc]");
		expect(out.error).toContain("payment_method");
		expect(out.error).toContain("o ERP recusa sem pagamento");
		expect(out.blockedLessonIds).toEqual(["cl0000lesson1abc"]);
		expect(out.hits[0]).toMatchObject({ source: "rule", action: "blocked", ruleKind: "required_args" });
	});

	it("preenchido passa; vazio, nulo e lista vazia contam como ausentes", () => {
		expect(runPreToolHooks(call(), state({ lessons: [lesson(rule)] })).error).toBeUndefined();
		for (const bad of ["", "  ", null, []]) {
			expect(runPreToolHooks(call({ args: { customer: { id: 7 }, payment_method: bad } }), state({ lessons: [lesson(rule)] })).error).toContain("payment_method");
		}
	});

	it("campo que a tool nem declara no schema nao bloqueia para sempre", () => {
		const ghost: LessonRule = { kind: "required_args", tool: "mcp__erp__create_proposal", fields: ["campo_fantasma"] };
		const out = runPreToolHooks(call(), state({ lessons: [lesson(ghost)] }));
		expect(out.error).toBeUndefined();
		expect(out.hits[0]).toMatchObject({ action: "skipped" });
	});
});

describe("require_prior_call", () => {
	const rule: LessonRule = { kind: "require_prior_call", tool: "mcp__erp__create_proposal", requires: "mcp__erp__list_payment_methods", within: "run" };

	it("sem chamada previa bem-sucedida: erro dizendo qual chamada falta", () => {
		const out = runPreToolHooks(call(), state({ lessons: [lesson(rule)] }));
		expect(out.error).toContain("mcp__erp__list_payment_methods");
		expect(out.error).toContain("antes de chamar");
	});

	it("com a chamada previa bem-sucedida no run, passa", () => {
		expect(runPreToolHooks(call(), state({ lessons: [lesson(rule)], succeeded: new Set(["mcp__erp__list_payment_methods"]) })).error).toBeUndefined();
	});

	it("se a chamada exigida nao existe neste run, a regra e ignorada (nunca bloqueia para sempre)", () => {
		const out = runPreToolHooks(call(), state({ lessons: [lesson(rule)], isToolAvailable: () => false }));
		expect(out.error).toBeUndefined();
		expect(out.hits[0]).toMatchObject({ action: "skipped" });
	});
});

describe("confirm_always e escopo", () => {
	const rule: LessonRule = { kind: "confirm_always", tool: "mcp__erp__*" };

	it("so aperta: forca o cartao em tool de conector; nao bloqueia", () => {
		const out = runPreToolHooks(call(), state({ lessons: [lesson(rule)] }));
		expect(out.forceConfirm).toBe(true);
		expect(out.error).toBeUndefined();
		expect(runPreToolHooks(call({ isMcp: false, name: "email_send", originalName: undefined }), state({ lessons: [lesson({ kind: "confirm_always", tool: "email_send" })] })).forceConfirm).toBe(false);
	});

	it("licao de conector ou de tool so vale para o seu escopo", () => {
		const rule2: LessonRule = { kind: "confirm_always", tool: "mcp__erp__create_proposal" };
		expect(runPreToolHooks(call(), state({ lessons: [lesson(rule2, { scope: "connector", scopeKey: "mcp:conn-erp" })] })).forceConfirm).toBe(true);
		expect(runPreToolHooks(call(), state({ lessons: [lesson(rule2, { scope: "connector", scopeKey: "mcp:outro" })] })).forceConfirm).toBe(false);
		expect(runPreToolHooks(call(), state({ lessons: [lesson(rule2, { scope: "tool", scopeKey: "mcp__erp__create_proposal" })] })).forceConfirm).toBe(true);
		expect(runPreToolHooks(call(), state({ lessons: [lesson(rule2, { scope: "tool", scopeKey: "mcp__erp__other" })] })).forceConfirm).toBe(false);
	});

	it("regra de outra tool nao dispara", () => {
		const other: LessonRule = { kind: "required_args", tool: "mcp__crm__create_lead", fields: ["email"] };
		expect(runPreToolHooks(call({ args: {} }), state({ lessons: [lesson(other)] })).error).toBeUndefined();
	});

	it("casa tambem pelo nome original da tool do conector", () => {
		const byOriginal: LessonRule = { kind: "required_args", tool: "create_proposal", fields: ["payment_method"] };
		expect(runPreToolHooks(call({ args: { customer: { id: 1 } } }), state({ lessons: [lesson(byOriginal)] })).error).toContain("payment_method");
	});
});
