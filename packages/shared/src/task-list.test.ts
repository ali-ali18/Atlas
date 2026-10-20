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
