import { describe, expect, it } from "vitest";
import {
	buildToolResultStatus,
	classifyFinish,
	createCapabilitySnapshot,
	createTaskState,
	MAX_LEDGER_EFFECTS,
	normalizeFinishReason,
	parseCapabilitySnapshot,
	parseLedgerEffects,
	parseLedgerResults,
	parseTaskState,
	parseToolResultStatus,
	uncertainEffects,
	unmetCriteria,
} from "./task-contracts.js";

describe("TaskState", () => {
	it("round-trips a created state", () => {
		const state = createTaskState("  prepare the summary  ");
		expect(state.objective).toEqual({ text: "prepare the summary", version: 1 });
		expect(parseTaskState(JSON.parse(JSON.stringify(state)))).toEqual(state);
	});

	it("returns undefined for old checkpoints and junk, never throws", () => {
		for (const raw of [undefined, null, "x", 3, [], {}, { v: 2, objective: {} }, { v: 1 }]) {
			expect(parseTaskState(raw)).toBeUndefined();
		}
	});

	it("drops malformed criteria and artifacts but keeps the rest", () => {
		const parsed = parseTaskState({
			v: 1,
			objective: { text: "goal", version: 3 },
			phase: "weird",
			criteria: [
				{ id: "artifact:file", kind: "artifact", description: "a file", status: "met", metBy: "f1" },
				{ id: "x", kind: "nope" },
				"junk",
			],
			artifacts: [{ kind: "file", ref: "a1", step: 2 }, { kind: "file" }, null],
			blockers: ["waiting", 4],
		});
		expect(parsed?.phase).toBe("executing");
		expect(parsed?.objective.version).toBe(3);
		expect(parsed?.criteria).toHaveLength(1);
		expect(parsed?.criteria[0]?.status).toBe("met");
		expect(parsed?.artifacts).toEqual([{ kind: "file", ref: "a1", step: 2 }]);
		expect(parsed?.blockers).toEqual(["waiting"]);
	});

	it("unmetCriteria lists only open ones", () => {
		const state = createTaskState("goal");
		state.criteria.push(
			{ id: "a", kind: "artifact", description: "a", status: "open" },
			{ id: "b", kind: "effect", description: "b", status: "met" },
		);
		expect(unmetCriteria(state).map((item) => item.id)).toEqual(["a"]);
	});
});

describe("CapabilitySnapshot", () => {
	it("dedupes tools and round-trips", () => {
		const snapshot = createCapabilitySnapshot({ tools: ["a", "b", "a"], vision: true, restrictions: ["x"] });
		expect(snapshot.tools).toEqual(["a", "b"]);
		expect(parseCapabilitySnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
	});

	it("is undefined for old checkpoints", () => {
		expect(parseCapabilitySnapshot(undefined)).toBeUndefined();
		expect(parseCapabilitySnapshot({ v: 1 })).toBeUndefined();
	});
});

describe("tool result status", () => {
	it("derives from what the executor knows", () => {
		expect(buildToolResultStatus({ ok: true, writes: true })).toEqual({ status: "ok", effect: "applied" });
		expect(buildToolResultStatus({ ok: true, writes: false })).toEqual({ status: "ok", effect: "none" });
		expect(buildToolResultStatus({ ok: false, writes: true })).toEqual({ status: "error", effect: "none" });
		expect(buildToolResultStatus({ ok: false, writes: true, uncertain: true, code: "timeout" })).toEqual({
			status: "uncertain",
			effect: "uncertain",
			code: "timeout",
		});
	});

	it("parses defensively", () => {
		expect(parseToolResultStatus({ status: "bad" })).toBeNull();
		expect(parseToolResultStatus({ status: "error", effect: "zzz" })).toEqual({ status: "error", effect: "none" });
		expect(parseLedgerResults({ a: { status: "ok", effect: "none" }, b: 3, "": { status: "ok" } })).toEqual({
			a: { status: "ok", effect: "none" },
		});
		expect(parseLedgerResults(undefined)).toEqual({});
	});
});

describe("effect journal", () => {
	it("parses, bounds and ignores junk", () => {
		const raw = Array.from({ length: MAX_LEDGER_EFFECTS + 5 }, (_, index) => ({
			attemptId: `k${index}`,
			tool: "t",
			argsHash: "h",
			step: index,
			state: "ok",
		}));
		const parsed = parseLedgerEffects([...raw, { tool: "x" }, 4]);
		expect(parsed).toHaveLength(MAX_LEDGER_EFFECTS);
		expect(parseLedgerEffects(undefined)).toEqual([]);
	});

	it("intent without result and uncertain are uncertain; resolved ones are not", () => {
		const effects = parseLedgerEffects([
			{ attemptId: "a", tool: "w", argsHash: "1", step: 0, state: "intent" },
			{ attemptId: "a", tool: "w", argsHash: "1", step: 0, state: "ok" },
			{ attemptId: "b", tool: "w", argsHash: "2", step: 1, state: "intent" },
			{ attemptId: "c", tool: "w", argsHash: "3", step: 2, state: "uncertain" },
			{ attemptId: "d", tool: "w", argsHash: "4", step: 3, state: "error" },
		]);
		expect(uncertainEffects(effects).map((item) => item.attemptId)).toEqual(["b", "c"]);
	});
});

describe("finish reason", () => {
	it("normalizes and classifies", () => {
		expect(classifyFinish(normalizeFinishReason("stop"))).toBe("normal");
		expect(classifyFinish(normalizeFinishReason("tool_calls"))).toBe("normal");
		expect(classifyFinish(normalizeFinishReason("length"))).toBe("truncated");
		expect(classifyFinish(normalizeFinishReason("content_filter"))).toBe("refusal");
		expect(classifyFinish(normalizeFinishReason(null))).toBe("incomplete");
		expect(classifyFinish(normalizeFinishReason("error"))).toBe("incomplete");
		// Origem que não informa o motivo (mock/legado) não vira falso alarme.
		expect(classifyFinish(undefined)).toBe("normal");
	});
});
