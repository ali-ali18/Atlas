import { describe, expect, it } from "vitest";
import {
	LEDGER_LAYER_CHARS,
	buildPartial,
	createTaskLedger,
	createTaskState,
	currentItem,
	describeOpenItems,
	isLedgerSatisfied,
	parseTaskLedger,
	parseTaskState,
	renderLedgerLayer,
	setLedgerItems,
	updateLedgerItem,
} from "./index.js";

const weeks = (n: number, scope = "Course A") =>
	Array.from({ length: n }, (_, i) => ({ label: `Week ${i + 1}`, scope }));

describe("setLedgerItems", () => {
	it("numera itens sem id e começa tudo pendente", () => {
		const ledger = setLedgerItems(createTaskLedger(), weeks(3));
		expect(ledger.items.map((item) => [item.id, item.status])).toEqual([["1", "pending"], ["2", "pending"], ["3", "pending"]]);
	});

	it("um segundo set preserva o que já foi lido (mesmo rótulo)", () => {
		let ledger = setLedgerItems(createTaskLedger(), weeks(3));
		ledger = updateLedgerItem(ledger, { id: "1", status: "done", evidence: "read the topics" });
		ledger = setLedgerItems(ledger, weeks(4));
		expect(ledger.items).toHaveLength(4);
		expect(ledger.items[0]).toMatchObject({ status: "done", evidence: "read the topics" });
		expect(ledger.items[3]!.status).toBe("pending");
	});

	it("rejeita lista vazia, rótulo vazio e mais de 40 itens com dica", () => {
		expect(() => setLedgerItems(createTaskLedger(), [])).toThrow(/at least one item/);
		expect(() => setLedgerItems(createTaskLedger(), [{ label: "  " }])).toThrow(/no label/);
		expect(() => setLedgerItems(createTaskLedger(), weeks(41))).toThrow(/at most 40/);
		expect(setLedgerItems(createTaskLedger(), weeks(40)).items).toHaveLength(40);
	});

	it("guarda fatos e plano com tetos", () => {
		const ledger = setLedgerItems(createTaskLedger(), weeks(1), {
			factsGiven: ["course A"],
			plan: Array.from({ length: 12 }, (_, i) => `step ${i}`),
		});
		expect(ledger.factsGiven).toEqual(["course A"]);
		expect(ledger.plan).toHaveLength(8);
	});
});

describe("updateLedgerItem", () => {
	const base = setLedgerItems(createTaskLedger(), weeks(2));

	it("done exige evidência", () => {
		expect(() => updateLedgerItem(base, { id: "1", status: "done" })).toThrow(/needs evidence/);
		expect(updateLedgerItem(base, { id: "1", status: "done", evidence: "x" }).items[0]!.status).toBe("done");
	});

	it("failed só com motivo de classe real", () => {
		expect(() => updateLedgerItem(base, { id: "1", status: "failed" })).toThrow(/real blocker/);
		expect(() => updateLedgerItem(base, { id: "1", status: "failed", reason: "the user can paste it" })).toThrow(/real blocker/);
		const failed = updateLedgerItem(base, { id: "1", status: "failed", reason: "login", detail: "sign-in page" });
		expect(failed.items[0]).toMatchObject({ status: "failed", reason: "login", detail: "sign-in page" });
	});

	it("id desconhecido lista os conhecidos", () => {
		expect(() => updateLedgerItem(base, { id: "9", status: "in_progress" })).toThrow(/Known ids: 1, 2/);
	});

	it("progresso zera o contador de estagnação", () => {
		const stalled = { ...base, stalled: 2 };
		expect(updateLedgerItem(stalled, { id: "1", status: "in_progress" }).stalled).toBe(0);
	});

	it("adota o ledger herdado ao usar a lista", () => {
		const carried = { ...base, carry: "offered" as const };
		expect(updateLedgerItem(carried, { id: "1", status: "in_progress" }).carry).toBe("adopted");
	});
});

describe("renderLedgerLayer", () => {
	it("null sem itens", () => {
		expect(renderLedgerLayer(createTaskLedger())).toBeNull();
	});

	it("mostra progresso, item corrente e o pai sempre à vista", () => {
		let ledger = setLedgerItems(createTaskLedger(), weeks(9, "Course A"));
		for (const id of ["1", "2", "3", "4"]) ledger = updateLedgerItem(ledger, { id, status: "done", evidence: "read" });
		const layer = renderLedgerLayer(ledger)!;
		expect(layer).toContain("Items: 4/9 done.");
		expect(layer).toContain('Now: item 5 "Week 5" (parent: Course A).');
		expect(layer).toContain('6 "Week 6"');
		expect(layer.length).toBeLessThanOrEqual(LEDGER_LAYER_CHARS);
	});

	it("respeita o teto de 600 caracteres com 40 itens longos", () => {
		const ledger = setLedgerItems(
			createTaskLedger(),
			Array.from({ length: 40 }, (_, i) => ({ label: `A very long section label number ${i} ${"x".repeat(80)}`, scope: "S".repeat(80) })),
		);
		const layer = renderLedgerLayer(ledger)!;
		expect(layer.length).toBeLessThanOrEqual(LEDGER_LAYER_CHARS);
		expect(layer).toContain("Items: 0/40 done.");
		expect(layer).toContain("(parent:");
	});

	it("ledger herdado aparece como oferta, sem Now", () => {
		const ledger = { ...setLedgerItems(createTaskLedger(), weeks(3)), carry: "offered" as const };
		const layer = renderLedgerLayer(ledger)!;
		expect(layer).toContain("earlier run");
		expect(layer).toContain("Answer the user's current request fully first");
		expect(layer).toContain("never clear the list on your own");
		expect(layer).not.toContain("Now:");
		expect(layer.length).toBeLessThanOrEqual(LEDGER_LAYER_CHARS);
	});
});

describe("estado do ledger", () => {
	it("satisfeito só quando há itens e nenhum aberto", () => {
		expect(isLedgerSatisfied(createTaskLedger())).toBe(false);
		let ledger = setLedgerItems(createTaskLedger(), weeks(2));
		expect(isLedgerSatisfied(ledger)).toBe(false);
		ledger = updateLedgerItem(ledger, { id: "1", status: "done", evidence: "x" });
		ledger = updateLedgerItem(ledger, { id: "2", status: "failed", reason: "not_found" });
		expect(isLedgerSatisfied(ledger)).toBe(true);
		expect(currentItem(ledger)).toBeUndefined();
	});

	it("item corrente prefere in_progress", () => {
		let ledger = setLedgerItems(createTaskLedger(), weeks(3));
		ledger = updateLedgerItem(ledger, { id: "3", status: "in_progress" });
		expect(currentItem(ledger)?.id).toBe("3");
	});

	it("describeOpenItems trunca com contagem", () => {
		const ledger = setLedgerItems(createTaskLedger(), weeks(30));
		expect(describeOpenItems(ledger, 100)).toMatch(/\+\d+ more$/);
	});

	it("buildPartial lista o que falta e o motivo", () => {
		let ledger = setLedgerItems(createTaskLedger(), weeks(3));
		ledger = updateLedgerItem(ledger, { id: "1", status: "done", evidence: "x" });
		ledger = updateLedgerItem(ledger, { id: "2", status: "failed", reason: "captcha" });
		expect(buildPartial(ledger, "not reached").missing).toEqual([
			{ id: "2", label: "Week 2", reason: "captcha" },
			{ id: "3", label: "Week 3", reason: "not reached" },
		]);
	});
});

describe("checkpoint", () => {
	it("parseTaskLedger tolera lixo e checkpoint antigo", () => {
		expect(parseTaskLedger(undefined)).toBeUndefined();
		expect(parseTaskLedger({ v: 2 })).toBeUndefined();
		const parsed = parseTaskLedger({ v: 1, items: [{ id: "1", label: "A", status: "weird" }, { nope: true }, { id: "1", label: "dup" }], stalled: -3 });
		expect(parsed?.items).toEqual([{ id: "1", label: "A", status: "pending" }]);
		expect(parsed?.stalled).toBe(0);
	});

	it("stopped e partial sobrevivem ao parse", () => {
		const base = { ...setLedgerItems(createTaskLedger(), weeks(2)), stopped: true, partial: { missing: [{ id: "2", label: "Week 2", reason: "captcha" }] } };
		const parsed = parseTaskLedger(JSON.parse(JSON.stringify(base)));
		expect(parsed?.stopped).toBe(true);
		expect(parsed?.partial?.missing[0]).toEqual({ id: "2", label: "Week 2", reason: "captcha" });
		expect(parseTaskLedger({ v: 1, items: [] })?.stopped).toBeUndefined();
	});

	it("o ledger sobrevive ao round-trip do TaskState; sem ledger fica ausente", () => {
		const state = createTaskState("read everything");
		expect(parseTaskState(JSON.parse(JSON.stringify(state)))?.ledger).toBeUndefined();
		const ledger = updateLedgerItem(setLedgerItems(createTaskLedger(), weeks(2)), { id: "1", status: "done", evidence: "x" });
		const round = parseTaskState(JSON.parse(JSON.stringify({ ...state, ledger })));
		expect(round?.ledger?.items[0]).toMatchObject({ id: "1", status: "done", evidence: "x" });
	});
});
