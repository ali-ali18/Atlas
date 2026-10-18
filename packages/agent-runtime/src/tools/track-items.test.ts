import { createTaskLedger, type TaskLedger } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { TRACK_ITEMS_TOOL, executeTrackItems, type LedgerStore } from "./track-items.js";

const memory = (initial?: TaskLedger): LedgerStore & { value: TaskLedger | undefined } => {
	const store = {
		value: initial,
		get: () => store.value,
		set: (next: TaskLedger | undefined) => {
			store.value = next;
		},
	};
	return store;
};
const weeks = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Week ${i + 1}`, scope: "Course A" }));
const run = (store: LedgerStore, args: Record<string, unknown>) => executeTrackItems(args, { ledgerStore: store });

describe("track_items", () => {
	it("a descrição diz quando usar e quando não usar", () => {
		const description = TRACK_ITEMS_TOOL.function.description ?? "";
		expect(description).toContain("USE WHEN");
		expect(description).toContain("DO NOT USE");
		expect(description).toContain("held back while items are open");
	});

	it("set grava a lista e devolve o resumo com o item pai", () => {
		const store = memory();
		const out = run(store, { action: "set", items: weeks(9), facts_given: ["course A"], plan: ["open the course", "read each week"] });
		expect(store.value?.items).toHaveLength(9);
		expect(store.value?.factsGiven).toEqual(["course A"]);
		expect(out.summary).toContain("Saved 9 items.");
		expect(out.summary).toContain('Now: item 1 "Week 1" (parent: Course A)');
	});

	it("aceita itens como texto simples", () => {
		const store = memory();
		run(store, { action: "set", items: ["A", "B", "C"] });
		expect(store.value?.items.map((item) => item.label)).toEqual(["A", "B", "C"]);
	});

	it("update done exige evidência; failed exige motivo de classe real", () => {
		const store = memory();
		run(store, { action: "set", items: weeks(3) });
		expect(() => run(store, { action: "update", id: "1", status: "done" })).toThrow(/needs evidence/);
		expect(() => run(store, { action: "update", id: "1", status: "failed", reason: "the user can paste it" })).toThrow(/real blocker/);
		const out = run(store, { action: "update", id: "1", status: "done", evidence: "read the topics" });
		expect(out.summary).toContain("Items: 1/3 done.");
		expect(out.summary).toContain('Now: item 2 "Week 2"');
	});

	it("vários updates numa chamada; erro no meio não grava nada", () => {
		const store = memory();
		run(store, { action: "set", items: weeks(3) });
		run(store, {
			action: "update",
			updates: [
				{ id: "1", status: "done", evidence: "a" },
				{ id: "2", status: "in_progress" },
			],
		});
		expect(store.value?.items.map((item) => item.status)).toEqual(["done", "in_progress", "pending"]);
		expect(() =>
			run(store, { action: "update", updates: [{ id: "3", status: "done", evidence: "c" }, { id: "9", status: "done", evidence: "x" }] }),
		).toThrow(/Unknown item id/);
		expect(store.value?.items[2]!.status).toBe("pending");
	});

	it("tudo fechado avisa que pode entregar", () => {
		const store = memory();
		run(store, { action: "set", items: weeks(1) });
		const out = run(store, { action: "update", id: "1", status: "done", evidence: "read" });
		expect(out.summary).toContain("Every item is closed: you can deliver now");
	});

	it("get devolve a lista atual; clear a remove", () => {
		const store = memory();
		expect(run(store, { action: "get" }).summary).toContain("No items yet");
		run(store, { action: "set", items: weeks(2) });
		expect(run(store, { action: "get" }).summary).toContain("Items: 0/2 done.");
		expect(run(store, { action: "clear" }).summary).toBe("Items cleared.");
		expect(store.value).toBeUndefined();
	});

	it("update sem lista dá a dica de declarar; ação inválida e run sem store falham", () => {
		expect(() => run(memory(), { action: "update", id: "1", status: "done", evidence: "x" })).toThrow(/declare them first/);
		expect(() => run(memory(), { action: "nope" })).toThrow(/action must be one of/);
		expect(() => executeTrackItems({ action: "get" }, {})).toThrow(/not available/);
		expect(() => run(memory(createTaskLedger()), { action: "set", items: [] })).toThrow(/at least one item/);
	});

	it("adotar: update num ledger herdado vira adotado", () => {
		const store = memory();
		run(store, { action: "set", items: weeks(2) });
		store.value = { ...store.value!, carry: "offered" };
		run(store, { action: "update", id: "1", status: "in_progress" });
		expect(store.value?.carry).toBe("adopted");
	});
});
