import { describe, expect, it } from "vitest";
import {
	budgetContinueOfferId,
	buildBudgetContinueCard,
	normalizeBudgetContinueUsd,
	parseBudgetContinueCard,
	readContinuationSource,
} from "./budget-continue.js";
import { isConversationCardRole, parseConversationCard, serializeConversationCard } from "./skill-card.js";

describe("card budget-continue", () => {
	it("tem identidade estável por run, valor em centavos e vai e volta pela serialização", () => {
		const card = buildBudgetContinueCard({ runId: "run-1", budgetUsd: 1.004 })!;
		expect(card).toEqual({ v: 1, kind: "budget-continue", offerId: budgetContinueOfferId("run-1"), runId: "run-1", budgetUsd: 1, status: "pending" });
		expect(isConversationCardRole("budget-continue")).toBe(true);
		expect(parseConversationCard(serializeConversationCard(card))).toEqual(card);
	});

	it("valor fora da faixa ou sem run não vira card", () => {
		expect(buildBudgetContinueCard({ runId: "r", budgetUsd: 0 })).toBeNull();
		expect(buildBudgetContinueCard({ runId: "r", budgetUsd: 999 })).toBeNull();
		expect(buildBudgetContinueCard({ runId: " ", budgetUsd: 1 })).toBeNull();
		expect(normalizeBudgetContinueUsd("1")).toBeNull();
		expect(normalizeBudgetContinueUsd(Number.NaN)).toBeNull();
	});

	it("parse: status desconhecido volta a pendente e lixo é recusado", () => {
		expect(parseBudgetContinueCard({ v: 1, kind: "budget-continue", offerId: "a", runId: "r", budgetUsd: 1, status: "x" })?.status).toBe("pending");
		expect(parseBudgetContinueCard({ v: 1, kind: "budget-continue", offerId: "a", runId: "r", budgetUsd: 1, status: "approved", continuationRunId: "n" })).toMatchObject({ status: "approved", continuationRunId: "n" });
		expect(parseBudgetContinueCard({ v: 2, kind: "budget-continue" })).toBeNull();
		expect(parseBudgetContinueCard({ v: 1, kind: "budget-continue", offerId: "", runId: "r", budgetUsd: 1 })).toBeNull();
	});

	it("lê de onde a continuação nasceu", () => {
		expect(readContinuationSource({ continuationOf: " run-9 " })).toBe("run-9");
		expect(readContinuationSource({})).toBeUndefined();
		expect(readContinuationSource(null)).toBeUndefined();
	});
});
