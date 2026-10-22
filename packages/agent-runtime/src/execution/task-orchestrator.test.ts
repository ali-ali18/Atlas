import { createTaskLedger, setLedgerItems, updateLedgerItem, type TaskLedger } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { ITEM_GATE_MAX_BLOCKS } from "./item-gate.js";
import { MAX_REPLANS, REPLAN_AFTER_STALLED } from "./progress-ledger.js";
import { createTaskOrchestrator, isBookkeepingOnly } from "./task-orchestrator.js";
import { createTaskTracker } from "./task-state.js";

const weeks = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Week ${i + 1}`, scope: "Course A" }));
const ctx = { budgetFraction: 0.2, canContinue: true, browserAvailable: true };
const build = (over: { ledger?: TaskLedger; prior?: unknown; require?: boolean } = {}) => {
	const tracker = createTaskTracker(undefined, "read all weeks");
	if (over.ledger) tracker.setLedger(over.ledger);
	const orchestrator = createTaskOrchestrator({ tracker, prior: over.prior, requireLedger: () => over.require ?? false });
	return { tracker, orchestrator };
};
const read = { actionKey: "read:e1", novelty: 1, bookkeepingOnly: false };
const idle = { actionKey: "click:e9", novelty: 0, bookkeepingOnly: false };

describe("createTaskOrchestrator", () => {
	it("sem ledger: sem camada, sem portão, sem estagnação", () => {
		const { orchestrator } = build();
		expect(orchestrator.layer()).toBeNull();
		expect(orchestrator.gate("final_answer", ctx)).toEqual({ action: "allow", declareGaps: false });
		expect(orchestrator.endDecision(idle)).toEqual({ note: null, stop: false });
		expect(orchestrator.hasOpenItems()).toBe(false);
	});

	it("portão conta a interceptação no ledger e libera na terceira", () => {
		const { orchestrator, tracker } = build({ ledger: setLedgerItems(createTaskLedger(), weeks(9)) });
		for (let i = 0; i < ITEM_GATE_MAX_BLOCKS; i += 1) {
			expect(orchestrator.gate("create_file", ctx).action).toBe("block");
			expect(tracker.ledger()?.gateBlocks).toBe(i + 1);
		}
		expect(orchestrator.gate("create_file", ctx)).toEqual({ action: "allow", declareGaps: true });
		expect(tracker.ledger()?.partial?.missing).toHaveLength(9);
		expect(orchestrator.gapsNote(0.2)).toContain("Some items are still open");
	});

	it("com 80% do orçamento libera, grava a parcial e pede a verdade sobre as lacunas", () => {
		const { orchestrator, tracker } = build({ ledger: updateLedgerItem(setLedgerItems(createTaskLedger(), weeks(9)), { id: "1", status: "done", evidence: "x" }) });
		expect(orchestrator.gapsNote(0.79)).toBeNull();
		expect(orchestrator.gapsNote(0.8)).toContain("state plainly");
		expect(orchestrator.gate("final_answer", { ...ctx, budgetFraction: 0.8 })).toEqual({ action: "allow", declareGaps: true });
		expect(tracker.ledger()?.partial?.missing.map((m) => m.id)).toEqual(["2", "3", "4", "5", "6", "7", "8", "9"]);
	});

	it("exige o ledger em tarefa de vários itens e guarda a contagem mesmo sem itens", () => {
		const { orchestrator, tracker } = build({ require: true });
		expect(orchestrator.gate("final_answer", ctx)).toMatchObject({ action: "block", kind: "ledger_required" });
		expect(tracker.ledger()?.gateBlocks).toBe(1);
		expect(orchestrator.layer()).toBeNull();
	});

	it("estagnação: K sem progresso replaneja, M replans e mais K encerram com parcial", () => {
		const { orchestrator } = build({ ledger: setLedgerItems(createTaskLedger(), weeks(4)) });
		const notes: string[] = [];
		let stopped = false;
		for (let i = 0; i < 40 && !stopped; i += 1) {
			const out = orchestrator.endDecision({ actionKey: `click:e${i}`, novelty: 0, bookkeepingOnly: false });
			if (out.note) notes.push(out.note);
			stopped = out.stop;
		}
		expect(stopped).toBe(true);
		expect(notes).toHaveLength(MAX_REPLANS + 1);
		expect(notes.slice(0, MAX_REPLANS).every((note) => note.includes("Update the plan"))).toBe(true);
		expect(notes[MAX_REPLANS]).toContain("Stopping with a partial result");
		expect(orchestrator.stopRequested()).toBe(true);
		// já encerrado: não repete o aviso
		expect(orchestrator.endDecision(idle)).toEqual({ note: null, stop: false });
		expect(REPLAN_AFTER_STALLED * (MAX_REPLANS + 1)).toBeGreaterThan(0);
	});

	it("conteúdo novo ou item fechado impede a estagnação", () => {
		const { orchestrator, tracker } = build({ ledger: setLedgerItems(createTaskLedger(), weeks(9)) });
		for (let i = 0; i < 12; i += 1) {
			expect(orchestrator.endDecision({ ...read, actionKey: `read:e${i}` }).note).toBeNull();
		}
		expect(tracker.ledger()?.stalled).toBe(0);
		orchestrator.endDecision(idle);
		orchestrator.endDecision({ ...idle, actionKey: "click:e10" });
		tracker.setLedger(updateLedgerItem(tracker.ledger()!, { id: "1", status: "done", evidence: "x" }));
		orchestrator.endDecision({ ...idle, actionKey: "click:e11" });
		expect(tracker.ledger()?.stalled).toBe(0);
	});

	it("decisão só de anotações (track_items, research_note) não conta como estagnação", () => {
		const { orchestrator, tracker } = build({ ledger: setLedgerItems(createTaskLedger(), weeks(3)) });
		for (let i = 0; i < 10; i += 1) orchestrator.endDecision({ actionKey: "track_items:x", novelty: 0, bookkeepingOnly: true });
		expect(tracker.ledger()?.stalled).toBe(0);
		expect(isBookkeepingOnly(["track_items", "research_note"])).toBe(true);
		expect(isBookkeepingOnly(["track_items", "computer"])).toBe(false);
		expect(isBookkeepingOnly([])).toBe(false);
	});

	describe("herança entre runs", () => {
		const prior = () => {
			let ledger = setLedgerItems(createTaskLedger(), weeks(5));
			ledger = updateLedgerItem(ledger, { id: "1", status: "done", evidence: "read" });
			return { ...ledger, stalled: 2, replans: 2, gateBlocks: 3, stopped: true, partial: { missing: [{ id: "2", label: "Week 2", reason: "x" }] } };
		};

		it("oferece o ledger anterior com contadores zerados, sem impor o portão", () => {
			const { orchestrator, tracker } = build({ prior: prior() });
			expect(tracker.ledger()).toMatchObject({ carry: "offered", stalled: 0, replans: 0, gateBlocks: 0 });
			expect(tracker.ledger()?.stopped).toBeUndefined();
			expect(tracker.ledger()?.partial).toBeUndefined();
			expect(orchestrator.layer()).toContain("earlier run");
			expect(orchestrator.hasOpenItems()).toBe(false);
			expect(orchestrator.gate("create_file", ctx).action).toBe("allow");
		});

		it("a resposta final do pedido novo passa direto, sem bloqueio nem marca no ledger", () => {
			const { orchestrator, tracker } = build({ prior: prior() });
			expect(orchestrator.gate("final_answer", ctx)).toEqual({ action: "allow", declareGaps: false });
			expect(tracker.ledger()?.carry).toBe("offered");
			expect(tracker.ledger()?.gateBlocks).toBe(0);
		});

		it("adotado (via track_items), o portão volta a valer e o Now aparece", () => {
			const { orchestrator, tracker } = build({ prior: prior() });
			tracker.setLedger(updateLedgerItem(tracker.ledger()!, { id: "2", status: "in_progress" }));
			expect(orchestrator.hasOpenItems()).toBe(true);
			expect(orchestrator.layer()).toContain('Now: item 2 "Week 2" (parent: Course A)');
			expect(orchestrator.gate("final_answer", ctx)).toMatchObject({ action: "block", kind: "items_open" });
		});

		it("ledger anterior concluído ou lixo não é herdado; o do checkpoint tem prioridade", () => {
			const finished = updateLedgerItem(setLedgerItems(createTaskLedger(), weeks(1)), { id: "1", status: "done", evidence: "x" });
			expect(build({ prior: finished }).tracker.ledger()).toBeUndefined();
			expect(build({ prior: { v: 9 } }).tracker.ledger()).toBeUndefined();
			const own = setLedgerItems(createTaskLedger(), [{ label: "Mine" }]);
			expect(build({ ledger: own, prior: prior() }).tracker.ledger()?.items[0]?.label).toBe("Mine");
		});
	});
});
