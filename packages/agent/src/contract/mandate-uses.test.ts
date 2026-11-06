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
