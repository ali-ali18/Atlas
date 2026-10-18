import { createTaskLedger, setLedgerItems, updateLedgerItem, type TaskLedger } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { MAX_REPLANS, REPLAN_AFTER_STALLED, advanceReplan, evaluateProgress, type StepSignal } from "./progress-ledger.js";

const weeks = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Week ${i + 1}`, scope: "Course A" }));
const open = (n = 4): TaskLedger => setLedgerItems(createTaskLedger(), weeks(n));
const idle: StepSignal = { actionKey: "click:a", novelty: 0, itemsClosed: 0 };

describe("evaluateProgress", () => {
	it("todos done ou failed = satisfeito", () => {
		let ledger = open(2);
		ledger = updateLedgerItem(ledger, { id: "1", status: "done", evidence: "x" });
		ledger = updateLedgerItem(ledger, { id: "2", status: "failed", reason: "not_found" });
		expect(evaluateProgress({ ledger, recent: [idle] }).satisfied).toBe(true);
		expect(evaluateProgress({ ledger: open(2), recent: [idle] }).satisfied).toBe(false);
	});

	it("item fechado ou conteúdo novo = progresso; nada novo = sem progresso", () => {
		const ledger = open();
		expect(evaluateProgress({ ledger, recent: [{ ...idle, itemsClosed: 1 }] }).progressing).toBe(true);
		expect(evaluateProgress({ ledger, recent: [{ ...idle, novelty: 2 }] }).progressing).toBe(true);
		expect(evaluateProgress({ ledger, recent: [idle] }).progressing).toBe(false);
		expect(evaluateProgress({ ledger, recent: [] }).progressing).toBe(false);
	});

	it("novidade não medida conta como progresso (sem estagnação falsa)", () => {
		expect(evaluateProgress({ ledger: open(), recent: [{ ...idle, novelty: undefined }] }).progressing).toBe(true);
	});

	it("mesma ação 3 vezes = laço, e laço com novidade não é progresso", () => {
		const loopStep: StepSignal = { actionKey: "click:e5", novelty: 1, itemsClosed: 0 };
		const verdict = evaluateProgress({ ledger: open(), recent: [loopStep, loopStep, loopStep] });
		expect(verdict.loop).toBe(true);
		expect(verdict.progressing).toBe(false);
		expect(evaluateProgress({ ledger: open(), recent: [loopStep, { ...loopStep, actionKey: "click:e6" }, loopStep] }).loop).toBe(false);
		const blank = { ...loopStep, actionKey: "" };
		expect(evaluateProgress({ ledger: open(), recent: [blank, blank, blank] }).loop).toBe(false);
	});

	it("próximo item é o corrente", () => {
		expect(evaluateProgress({ ledger: open(), recent: [idle] }).nextItem?.id).toBe("1");
	});

	it("item fechado no mesmo passo do laço vence o laço", () => {
		const loopStep: StepSignal = { actionKey: "click:e5", novelty: 0, itemsClosed: 0 };
		const verdict = evaluateProgress({ ledger: open(), recent: [loopStep, loopStep, { ...loopStep, itemsClosed: 1 }] });
		expect(verdict.progressing).toBe(true);
	});
});

describe("advanceReplan", () => {
	const stall = (ledger: TaskLedger) => advanceReplan(ledger, { satisfied: false, loop: false, progressing: false, nextItem: undefined });
	const progress = (ledger: TaskLedger) => advanceReplan(ledger, { satisfied: false, loop: false, progressing: true, nextItem: undefined });

	it("K passos sem progresso disparam o replan (nunca antes)", () => {
		let ledger = open();
		for (let i = 1; i < REPLAN_AFTER_STALLED; i += 1) {
			const out = stall(ledger);
			expect(out.action).toBe("none");
			ledger = out.ledger;
		}
		const out = stall(ledger);
		expect(out.action).toBe("replan");
		if (out.action !== "replan") return;
		expect(out.ledger.replans).toBe(1);
		expect(out.ledger.stalled).toBe(0);
		expect(out.note).toContain("No progress in the last 3 steps");
		expect(out.note).toContain('1 "Week 1" (parent: Course A)');
		expect(out.note).toContain("Update the plan");
	});

	it("progresso zera a contagem", () => {
		let ledger = open();
		ledger = stall(ledger).ledger;
		ledger = stall(ledger).ledger;
		expect(ledger.stalled).toBe(2);
		expect(progress(ledger).ledger.stalled).toBe(0);
	});

	it("após M replans e mais K sem progresso: para com parcial honesta", () => {
		let ledger = updateLedgerItem(open(3), { id: "1", status: "done", evidence: "x" });
		let replans = 0;
		let stopped: ReturnType<typeof stall> | undefined;
		for (let i = 0; i < 40 && !stopped; i += 1) {
			const out = stall(ledger);
			ledger = out.ledger;
			if (out.action === "replan") replans += 1;
			if (out.action === "stop") stopped = out;
		}
		expect(replans).toBe(MAX_REPLANS);
		expect(stopped?.action).toBe("stop");
		if (stopped?.action !== "stop") return;
		expect(stopped.note).toContain("Stopping with a partial result");
		expect(stopped.note).toContain("Done: 1");
		expect(stopped.note).toContain('2 "Week 2"');
		expect(stopped.note).toContain("Do not ask the user");
		expect(stopped.ledger.stopped).toBe(true);
		expect(stopped.ledger.partial?.missing.map((item) => item.id)).toEqual(["2", "3"]);
	});

	it("sem itens abertos ou com checklist herdado não conta estagnação", () => {
		const done = updateLedgerItem(open(1), { id: "1", status: "done", evidence: "x" });
		expect(stall({ ...done, stalled: 2 }).ledger.stalled).toBe(0);
		expect(stall({ ...open(), carry: "offered" }).ledger.stalled).toBe(0);
	});
});
