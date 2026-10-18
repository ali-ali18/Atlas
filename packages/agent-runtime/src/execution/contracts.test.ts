import { describe, expect, it } from "vitest";
import type { AgentRunCheckpoint } from "@workspace/shared";
import { buildRuntimeCheckpoint, parseRuntimeCheckpoint } from "../checkpoint.js";
import { createEffectJournal, hashEffectArgs, isJournaledWrite } from "./journal.js";
import { parseLedgerState } from "./ledger.js";
import { createTaskTracker, FILE_CRITERION_ID } from "./task-state.js";

const base = { messages: [], conversation: [], nextStepIndex: 3, model: "m" };

describe("checkpoint contracts", () => {
	it("old checkpoint (no contracts) still loads", () => {
		const old = parseRuntimeCheckpoint({ version: 2, messages: [], nextStepIndex: 4, executionLedger: { v: 1, decisions: [] } });
		expect(old?.nextStepIndex).toBe(4);
		expect(old?.taskState).toBeUndefined();
		expect(old?.capabilities).toBeUndefined();
		expect(old?.executionLedger?.effects).toBeUndefined();
		expect(old?.executionLedger?.results).toBeUndefined();
	});

	it("new checkpoint round-trips task state, capabilities, effects and results", () => {
		const tracker = createTaskTracker(undefined, "goal");
		tracker.expectFile("a file");
		const journal = createEffectJournal();
		journal.intent({ attemptId: "k1", tool: "w", argsHash: "h", step: 1 });
		journal.recordResult("c1", { status: "error", effect: "none", code: "x" });
		const checkpoint = buildRuntimeCheckpoint({
			...base,
			taskState: tracker.snapshot(),
			capabilities: { v: 1, tools: ["a"], vision: false, restrictions: [] },
			executionLedger: { ...parseLedgerState(undefined), ...journal.snapshot() },
		});
		const parsed = parseRuntimeCheckpoint(JSON.parse(JSON.stringify(checkpoint))) as AgentRunCheckpoint;
		expect(parsed.taskState?.criteria[0]?.id).toBe(FILE_CRITERION_ID);
		expect(parsed.capabilities?.vision).toBe(false);
		expect(parsed.executionLedger?.effects?.[0]).toMatchObject({ attemptId: "k1", state: "intent" });
		expect(parsed.executionLedger?.results?.c1).toEqual({ status: "error", effect: "none", code: "x" });
	});

	it("garbage in the new fields is dropped, not fatal", () => {
		const parsed = parseRuntimeCheckpoint({ messages: [], taskState: 7, capabilities: "x", executionLedger: { v: 1, effects: "no", results: [] } });
		expect(parsed?.taskState).toBeUndefined();
		expect(parsed?.capabilities).toBeUndefined();
		expect(parsed?.executionLedger?.effects).toBeUndefined();
	});
});

describe("effect journal", () => {
	it("intent without a result is uncertain; settled is not", () => {
		const journal = createEffectJournal();
		journal.intent({ attemptId: "a", tool: "w", argsHash: "1", step: 0 });
		journal.intent({ attemptId: "b", tool: "w", argsHash: "2", step: 1 });
		journal.settle("a", "ok");
		expect(journal.uncertain().map((item) => item.attemptId)).toEqual(["b"]);
		journal.settle("b", "uncertain", "timeout");
		expect(journal.uncertain().map((item) => item.attemptId)).toEqual(["b"]);
		journal.settle("b", "error");
		expect(journal.uncertain()).toEqual([]);
	});

	it("survives a snapshot/restore", () => {
		const journal = createEffectJournal();
		journal.intent({ attemptId: "a", tool: "w", argsHash: "1", step: 0 });
		const restored = createEffectJournal(JSON.parse(JSON.stringify(journal.snapshot())));
		expect(restored.uncertain()).toHaveLength(1);
	});

	it("hashes args independent of key order and classifies writes", () => {
		expect(hashEffectArgs({ a: 1, b: 2 })).toBe(hashEffectArgs({ b: 2, a: 1 }));
		expect(hashEffectArgs({ a: 1 })).not.toBe(hashEffectArgs({ a: 2 }));
		expect(isJournaledWrite("x", { readOnly: false })).toBe(true);
		expect(isJournaledWrite("x", { readOnly: true })).toBe(false);
		expect(isJournaledWrite("create_file")).toBe(true);
		expect(isJournaledWrite("web_search")).toBe(false);
	});
});

describe("task tracker", () => {
	it("starts with no criteria and nothing to enforce", () => {
		expect(createTaskTracker(undefined, "goal").unmet()).toEqual([]);
	});

	it("an expected file stays open until a file artifact is recorded", () => {
		const tracker = createTaskTracker(undefined, "goal");
		tracker.expectFile("file promised");
		expect(tracker.unmet()).toHaveLength(1);
		tracker.recordArtifact({ kind: "file", ref: "art1", step: 2 });
		expect(tracker.unmet()).toEqual([]);
	});

	it("a file that already exists makes the criterion start met", () => {
		const tracker = createTaskTracker(undefined, "goal");
		tracker.recordArtifact({ kind: "file", ref: "art1", step: 0 });
		tracker.expectFile("file promised");
		expect(tracker.unmet()).toEqual([]);
	});

	it("revises the objective with a new version and resumes from a snapshot", () => {
		const tracker = createTaskTracker(undefined, "goal");
		tracker.reviseObjective("new goal");
		const resumed = createTaskTracker(JSON.parse(JSON.stringify(tracker.snapshot())), "ignored");
		expect(resumed.snapshot().objective).toEqual({ text: "new goal", version: 2 });
	});
});
