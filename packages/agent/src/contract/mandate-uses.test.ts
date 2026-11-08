import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Mandate } from "@workspace/shared";
import { chatPolicy, setup } from "../testing/contract-helpers.js";
import { sha256 } from "../testing/fake-ports.js";
import { defineTool } from "../tools/define-tool.js";
import { createExecutor } from "./executor.js";

const mandate = (usesLeft: number): Mandate => ({ maxAmount: 100, currency: "BRL", merchants: ["mercado"], until: "2027-01-01T00:00:00Z", usesLeft });

function payTool() {
	const counter = { runs: 0 };
	const tool = defineTool({
		name: "pay_order",
		description: "Pay an order.",
		inputSchema: z.object({ order: z.string() }),
		effect: "money",
		riskFacts: () => ({ amount: 30, currency: "BRL", merchant: "mercado" }),
		execute: ({ order }) => {
			counter.runs++;
			return { ok: true, summary: `paid ${order}`, receipt: { what: `Pago ${order}` } };
		},
	});
	return { tool, counter };
}

describe("mandato consome usos (auditoria F1, S6)", () => {
	it("usesLeft 1: a primeira compra roda pelo mandato, a segunda pede aprovação", async () => {
		const { executor } = setup({ ...chatPolicy, mandate: mandate(1) });
		const { tool, counter } = payTool();
		expect((await executor.executeCall({ callId: "c1", step: 1, tool, args: { order: "a" } })).status).toBe("ok");
		expect(executor.mandateUsesLeft()).toBe(0);
		expect((await executor.executeCall({ callId: "c2", step: 1, tool, args: { order: "b" } })).status).toBe("pending_approval");
		expect(counter.runs).toBe(1);
	});

	it("N usos: N compras rodam, a seguinte pede aprovação", async () => {
		const { executor } = setup({ ...chatPolicy, mandate: mandate(3) });
		const { tool, counter } = payTool();
		const statuses = [];
		for (let i = 0; i < 4; i++) statuses.push((await executor.executeCall({ callId: `c${i}`, step: 1, tool, args: { order: `o${i}` } })).status);
		expect(statuses).toEqual(["ok", "ok", "ok", "pending_approval"]);
		expect(counter.runs).toBe(3);
	});

	it("a retomada (outro executor) respeita os usos que restavam no checkpoint", async () => {
		const first = setup({ ...chatPolicy, mandate: mandate(2) });
		const { tool } = payTool();
		await first.executor.executeCall({ callId: "c1", step: 1, tool, args: { order: "a" } });
		const resumed = createExecutor({ runId: "run-1", ownerId: "owner-1", ports: first.ports, hash: sha256, policy: { ...chatPolicy, mandate: mandate(2) }, mandateUsesLeft: first.executor.mandateUsesLeft() });
		expect((await resumed.executeCall({ callId: "c2", step: 1, tool, args: { order: "b" } })).status).toBe("ok");
		expect((await resumed.executeCall({ callId: "c3", step: 1, tool, args: { order: "c" } })).status).toBe("pending_approval");
	});

	it("sem mandato não há contagem; aprovação explícita do dono não gasta uso", async () => {
		const { executor } = setup(chatPolicy);
		expect(executor.mandateUsesLeft()).toBeUndefined();
		const withMandate = setup({ ...chatPolicy, mandate: { ...mandate(1), merchants: ["outra"] } });
		const { tool } = payTool();
		expect((await withMandate.executor.executeCall({ callId: "c1", step: 1, tool, args: { order: "a" } })).status).toBe("pending_approval");
		expect(withMandate.executor.mandateUsesLeft()).toBe(1);
	});
});

describe("mandato: gasto atômico do uso no armazém (corrida entre runs)", () => {
	function store(initial: number) {
		const state = { left: initial };
		return { state, uses: { claim: async () => (state.left > 0 ? (state.left--, true) : false), release: async () => void state.left++ } };
	}

	it("dois runs com 1 uso no banco: só um paga; o outro falha honesto, sem executar e sem deixar a escrita pendurada", async () => {
		const shared = store(1);
		const { tool, counter } = payTool();
		const a = setup({ ...chatPolicy, mandate: mandate(1) }, { mandateUses: shared.uses });
		const b = setup({ ...chatPolicy, mandate: mandate(1) }, { mandateUses: shared.uses });
		const [ra, rb] = await Promise.all([a.executor.executeCall({ callId: "c1", step: 1, tool, args: { order: "a" } }), b.executor.executeCall({ callId: "c1", step: 1, tool, args: { order: "b" } })]);
		expect([ra.status, rb.status].sort()).toEqual(["error", "ok"]);
		expect(counter.runs).toBe(1);
		expect(shared.state.left).toBe(0);
		const loser = ra.status === "error" ? ra : rb;
		if (loser.status !== "error") throw new Error("esperava erro");
		expect(loser.error).toMatch(/no uses left/);
	});

	it("a tool que falha sem pagar devolve o uso (banco e memória)", async () => {
		const shared = store(1);
		const failing = defineTool({ name: "pay_order", description: "Pay.", inputSchema: z.object({ order: z.string() }), effect: "money", riskFacts: () => ({ amount: 30, currency: "BRL", merchant: "mercado" }), execute: () => ({ ok: false, error: "no code", hint: "ask again" }) });
		const s = setup({ ...chatPolicy, mandate: mandate(1) }, { mandateUses: shared.uses });
		expect((await s.executor.executeCall({ callId: "c1", step: 1, tool: failing, args: { order: "a" } })).status).toBe("error");
		expect(shared.state.left).toBe(1);
		expect(s.executor.mandateUsesLeft()).toBe(1);
	});

	it("a compra que paga mantém o uso gasto", async () => {
		const shared = store(2);
		const { tool } = payTool();
		const s = setup({ ...chatPolicy, mandate: mandate(2) }, { mandateUses: shared.uses });
		expect((await s.executor.executeCall({ callId: "c1", step: 1, tool, args: { order: "a" } })).status).toBe("ok");
		expect(shared.state.left).toBe(1);
	});
});
