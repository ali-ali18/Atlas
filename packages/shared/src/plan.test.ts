import { describe, expect, it } from "vitest";
import {
	PLAN_APPROVED_RESULT,
	PLAN_ADJUST_RESULT,
	normalizePlanInput,
	parsePlanInfo,
	planAdjustResult,
	planApprovedResult,
	planToTaskList,
	readPlanMode,
	withPlanMode,
} from "./plan.js";
import { parseConversationCard, serializeConversationCard } from "./skill-card.js";

const plan = {
	title: "Migrar pedidos",
	steps: [
		{ text: "Listar pedidos abertos", kind: "read" as const },
		{ text: "Criar a proposta no ERP", kind: "write" as const },
		{ text: "Confirmar a forma de pagamento", kind: "ask" as const },
	],
	needs: ["Forma de pagamento"],
	risks: "Proposta criada nao se desfaz",
};

describe("propose_plan: validacao", () => {
	it("normaliza texto, tipo e listas", () => {
		const out = normalizePlanInput({ title: "  Meu   plano ", steps: [{ text: " a  b ", kind: "read" }, { text: "c" }], needs: [" x ", ""], risks: "  r " });
		expect(out).toEqual({ title: "Meu plano", steps: [{ text: "a b", kind: "read" }, { text: "c", kind: "other" }], needs: ["x"], risks: "r" });
	});

	it("rejeita titulo vazio, sem passos, tipo invalido, passo vazio e plano grande", () => {
		const call = (args: Record<string, unknown>) => () => normalizePlanInput(args);
		expect(call({ title: " ", steps: [{ text: "a", kind: "read" }] })).toThrow(/title/);
		expect(call({ title: "t", steps: [] })).toThrow(/steps/);
		expect(call({ title: "t", steps: [{ text: "a", kind: "delete" }] })).toThrow(/kind/);
		expect(call({ title: "t", steps: [{ text: " ", kind: "read" }] })).toThrow(/text/);
		expect(call({ title: "t", steps: Array.from({ length: 21 }, () => ({ text: "a", kind: "read" })) })).toThrow(/max 20/);
	});

	it("semeia a lista de tarefas: primeiro em andamento, resto pendente", () => {
		expect(planToTaskList(plan)).toEqual([
			{ content: "Listar pedidos abertos", status: "in_progress" },
			{ content: "Criar a proposta no ERP", status: "pending" },
			{ content: "Confirmar a forma de pagamento", status: "pending" },
		]);
	});

	it("o resultado aprovado leva o plano e avisa que escritas continuam pedindo aprovacao", () => {
		const text = planApprovedResult(plan);
		expect(text.startsWith(PLAN_APPROVED_RESULT)).toBe(true);
		expect(text).toContain("2. [write] Criar a proposta no ERP");
		expect(text).toContain("does NOT approve individual writes");
		expect(planAdjustResult("  troque   o passo 2 ").startsWith(PLAN_ADJUST_RESULT)).toBe(true);
		expect(planAdjustResult("troque o passo 2")).toContain("troque o passo 2");
	});
});

describe("plano no cartao e no ajuste do bot", () => {
	it("round-trip pelo cartao de confirmacao e leitura tolerante", () => {
		const card = { v: 1 as const, kind: "confirm" as const, confirmId: "confirm-plan-r1", title: plan.title, status: "pending" as const, confirmLabel: "Aprovar plano", cancelLabel: "Cancelar", plan };
		expect(parseConversationCard(serializeConversationCard(card))).toEqual(card);
		expect(parsePlanInfo({ title: "t", steps: [{ text: "a", kind: "xx" }, { text: "" }, 3] })).toEqual({ title: "t", steps: [{ text: "a", kind: "other" }] });
		expect(parsePlanInfo({ title: "t", steps: [] })).toBeUndefined();
		const withoutPlan = parseConversationCard(JSON.stringify({ v: 1, kind: "confirm", confirmId: "c", title: "t", status: "pending", plan: "lixo" }));
		expect(withoutPlan && "plan" in withoutPlan).toBe(false);
	});

	it("planejar antes de tarefas grandes: ligado por padrao; so false desliga", () => {
		expect(readPlanMode(null)).toBe(true);
		expect(readPlanMode({})).toBe(true);
		expect(readPlanMode({ planMode: true })).toBe(true);
		expect(readPlanMode({ planMode: false })).toBe(false);
		expect(withPlanMode({ codingModel: "x" }, false)).toEqual({ codingModel: "x", planMode: false });
		expect(withPlanMode({ planMode: false, codingModel: "x" }, true)).toEqual({ codingModel: "x" });
	});
});
