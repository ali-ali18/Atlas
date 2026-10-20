import { describe, expect, it } from "vitest";
import { createTaskState, parseTaskState } from "./task-contracts.js";
import { parseTaskList } from "./task-list.js";

describe("task list no TaskState", () => {
	it("sobrevive ao parse do checkpoint e descarta itens invalidos", () => {
		const state = { ...createTaskState("x"), taskList: [{ content: "a", status: "pending" }, { content: "", status: "pending" }, { content: "b", status: "nope" }, { content: "c", status: "completed" }] };
		expect(parseTaskState(state)?.taskList).toEqual([{ content: "a", status: "pending" }, { content: "c", status: "completed" }]);
		expect(parseTaskState(createTaskState("x"))?.taskList).toBeUndefined();
		expect(parseTaskList("lixo")).toBeUndefined();
	});
});

describe("cartao task-list", () => {
	it("round-trip pelo parse de cartoes e rejeita sem runId ou itens", async () => {
		const { parseConversationCard, serializeConversationCard, isConversationCardRole } = await import("./skill-card.js");
		const card = { v: 1 as const, kind: "task-list" as const, runId: "r1", items: [{ content: "a", status: "pending" as const }] };
		expect(parseConversationCard(serializeConversationCard(card))).toEqual(card);
		expect(parseConversationCard(JSON.stringify({ v: 1, kind: "task-list", items: card.items }))).toBeNull();
		expect(parseConversationCard(JSON.stringify({ v: 1, kind: "task-list", runId: "r1", items: [] }))).toBeNull();
		expect(isConversationCardRole("task-list")).toBe(true);
	});
});
