import { createTaskLedger, setLedgerItems, updateLedgerItem, type TaskLedger } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { ITEM_GATE_MAX_BLOCKS, LEDGER_REQUIRED_NOTE, decideItemGate, type GateInput } from "./item-gate.js";

const weeks = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Week ${i + 1}`, scope: "Course A" }));
const withItems = (n: number, done = 0): TaskLedger => {
	let ledger = setLedgerItems(createTaskLedger(), weeks(n));
	for (let i = 1; i <= done; i += 1) ledger = updateLedgerItem(ledger, { id: String(i), status: "done", evidence: "read" });
	return ledger;
};
const gate = (over: Partial<GateInput>) =>
	decideItemGate({ ledger: undefined, event: "create_file", budgetFraction: 0.2, requireLedger: false, browserAvailable: true, canContinue: true, ...over });

describe("decideItemGate", () => {
	it("sem ledger ou sem itens: libera", () => {
		expect(gate({})).toEqual({ action: "allow", declareGaps: false });
		expect(gate({ ledger: createTaskLedger() })).toEqual({ action: "allow", declareGaps: false });
	});

	it("tudo done (ou failed com motivo): libera sem lacunas", () => {
		expect(gate({ ledger: withItems(3, 3) })).toEqual({ action: "allow", declareGaps: false });
		const failed = updateLedgerItem(withItems(2, 1), { id: "2", status: "failed", reason: "login" });
		expect(gate({ ledger: failed })).toEqual({ action: "allow", declareGaps: false });
	});

	it("1 de 9 lido: bloqueia create_file e resposta final, listando os pendentes", () => {
		for (const event of ["create_file", "final_answer"] as const) {
			const decision = gate({ ledger: withItems(9, 1), event });
			expect(decision.action).toBe("block");
			if (decision.action !== "block") continue;
			expect(decision.kind).toBe("items_open");
			expect(decision.note).toContain("8 items are still open");
			expect(decision.note).toContain('2 "Week 2" (Course A)');
			expect(decision.note).toContain("do not ask the user to paste it");
		}
	});

	it("sem navegador, a nota não fala do navegador", () => {
		const decision = gate({ ledger: withItems(3), browserAvailable: false });
		expect(decision.action === "block" && decision.note).not.toContain("browser");
	});

	it("limite do orçamento: 79% bloqueia, 80% e 90% liberam declarando lacunas", () => {
		const ledger = withItems(9, 1);
		expect(gate({ ledger, budgetFraction: 0.79 }).action).toBe("block");
		expect(gate({ ledger, budgetFraction: 0.8 })).toEqual({ action: "allow", declareGaps: true });
		expect(gate({ ledger, budgetFraction: 0.9 })).toEqual({ action: "allow", declareGaps: true });
	});

	it("depois de 3 interceptações libera com lacunas", () => {
		const ledger = { ...withItems(9, 1), gateBlocks: ITEM_GATE_MAX_BLOCKS - 1 };
		expect(gate({ ledger }).action).toBe("block");
		expect(gate({ ledger: { ...ledger, gateBlocks: ITEM_GATE_MAX_BLOCKS } })).toEqual({ action: "allow", declareGaps: true });
	});

	it("fechamento forçado (sem tools) nunca segura a resposta", () => {
		expect(gate({ ledger: withItems(9, 1), event: "final_answer", canContinue: false })).toEqual({ action: "allow", declareGaps: true });
	});

	it("tarefa de vários itens sem ledger: exige declarar, no máximo 3 vezes", () => {
		expect(gate({ requireLedger: true })).toEqual({ action: "block", kind: "ledger_required", note: LEDGER_REQUIRED_NOTE });
		expect(gate({ requireLedger: true, ledger: { ...createTaskLedger(), gateBlocks: ITEM_GATE_MAX_BLOCKS } }).action).toBe("allow");
	});

	it("checklist herdado não adotado nunca segura a resposta final nem o arquivo", () => {
		const offered = { ...withItems(4, 1), carry: "offered" as const };
		expect(gate({ ledger: offered, event: "final_answer" })).toEqual({ action: "allow", declareGaps: false });
		expect(gate({ ledger: offered, event: "create_file" }).action).toBe("allow");
		expect(gate({ ledger: { ...offered, carry: "asked" }, event: "final_answer" }).action).toBe("allow");
	});

	it("checklist adotado volta a segurar a entrega", () => {
		const adopted = { ...withItems(4, 1), carry: "adopted" as const };
		expect(gate({ ledger: adopted }).action).toBe("block");
	});
});
