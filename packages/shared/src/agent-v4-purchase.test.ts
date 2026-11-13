import { describe, expect, it } from "vitest";
import type { ApprovalRequestEvent } from "./agent-v4-events.js";
import { purchaseRequestFromEvent } from "./agent-v4-purchase.js";

const event = (over: Partial<ApprovalRequestEvent> = {}): ApprovalRequestEvent => ({
	type: "approval_request",
	requestId: "req-1",
	callId: "c1",
	toolName: "checkout",
	effect: "money",
	args: {},
	riskFacts: { amount: 109.8, currency: "brl", merchant: "loja.test", shipping: 10, card: "Visa final 1111", items: ["2× Camiseta"] },
	ownerInput: "card_cvv",
	runId: "run-1",
	...over,
});

describe("purchaseRequestFromEvent", () => {
	it("lê os fatos da compra e normaliza a moeda", () => {
		const request = purchaseRequestFromEvent(event());
		expect(request?.facts).toEqual({ store: "loja.test", items: ["2× Camiseta"], amount: 109.8, currency: "BRL", shipping: 10, card: "Visa final 1111" });
		expect(request?.inputOnly).toBe(false);
		expect(purchaseRequestFromEvent(event({ inputOnly: true }))?.inputOnly).toBe(true);
	});
	it("não é compra sem o campo de CVV, sem run ou com fatos malformados", () => {
		expect(purchaseRequestFromEvent(event({ ownerInput: undefined }))).toBeNull();
		expect(purchaseRequestFromEvent(event({ runId: undefined }))).toBeNull();
		expect(purchaseRequestFromEvent(event({ riskFacts: { currency: "BRL" } }))).toBeNull();
		expect(purchaseRequestFromEvent(event({ riskFacts: { amount: -1, currency: "BRL", merchant: "x" } }))).toBeNull();
	});
});
