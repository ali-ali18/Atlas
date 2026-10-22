import { createTaskLedger, setLedgerItems } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { createTaskTracker } from "./task-state.js";

const ledger = () => setLedgerItems(createTaskLedger(), [{ label: "Proposta 3801" }]);

describe("TaskTracker.persistable", () => {
	it("não regrava o checklist herdado que o run não adotou", () => {
		for (const carry of ["offered", "asked"] as const) {
			const tracker = createTaskTracker(undefined, "preço canela");
			tracker.setLedger({ ...ledger(), carry });
			expect(tracker.persistable().ledger).toBeUndefined();
			// o estado em memória segue intacto para o resto do run
			expect(tracker.ledger()?.carry).toBe(carry);
		}
	});

	it("grava o ledger adotado ou criado no próprio run", () => {
		const tracker = createTaskTracker(undefined, "x");
		tracker.setLedger({ ...ledger(), carry: "adopted" });
		expect(tracker.persistable().ledger?.items).toHaveLength(1);
		tracker.setLedger(ledger());
		expect(tracker.persistable().ledger?.items).toHaveLength(1);
	});
});
