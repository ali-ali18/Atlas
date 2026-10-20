import { describe, expect, it } from "vitest";
import type { LlmMessage } from "@workspace/llm";
import { categorizeMessages, createStepInspector, INSPECT_REQUEST_STEP_MAX } from "./inspect.js";

const tool = (name: string) => ({ type: "function" as const, function: { name, description: "d", parameters: { type: "object" } } });
const messages: LlmMessage[] = [
	{ role: "system", content: "a".repeat(400) },
	{ role: "user", content: "b".repeat(80) },
	{ role: "assistant", content: "c".repeat(80) },
	{ role: "system", content: "n".repeat(40) },
	{ role: "user", content: "d".repeat(80) },
	{ role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read", arguments: "{}" } }] },
	{ role: "tool", tool_call_id: "1", content: "r".repeat(200) },
];

describe("categorizeMessages", () => {
	it("separa instruções, notas, histórico, resultados e turno atual", () => {
		const out = categorizeMessages(messages);
		expect(out.system).toBeGreaterThan(out.toolResults);
		expect(out.toolResults).toBeGreaterThan(out.history);
		expect(out.history).toBeGreaterThan(out.notes);
		expect(out.notes).toBeGreaterThan(0);
		expect(out.turn).toBeGreaterThan(0);
	});
});

describe("createStepInspector", () => {
	it("tools completas no 1o passo e só delta nos seguintes; consome as ações", () => {
		const inspector = createStepInspector({ full: false });
		inspector.noteHygiene({ contextLength: 1000, estimatedTokensBefore: 900, estimatedTokensAfter: 500, collapsedGroups: 2, trimmedMessages: 3, guard: "soft" });
		inspector.noteAction({ kind: "summary", before: 900, after: 300 });
		const first = inspector.step({ messages, tools: [tool("a"), tool("b")], contextLength: 1000 });
		expect(first.tools).toEqual({ count: 2, names: ["a", "b"] });
		expect(first.actions.map((action) => action.kind)).toEqual(["collapsed", "trimmed", "guard", "summary"]);
		expect(first.total).toBe(Object.values(first.tokens).reduce((a, b) => a + b, 0));
		expect(first.request).toBeUndefined();
		const second = inspector.step({ messages, tools: [tool("b"), tool("c")] });
		expect(second.tools).toEqual({ count: 2, added: ["c"], removed: ["a"] });
		expect(second.actions).toEqual([]);
	});

	it("pedido completo só com a flag, redigido e limitado", () => {
		const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
		const big: LlmMessage[] = [{ role: "system", content: "sys" }, ...Array.from({ length: 80 }, (_, i): LlmMessage => ({ role: "user", content: `${i} ${secret} ${"x".repeat(3000)}` }))];
		const inspector = createStepInspector({ full: true });
		const step = inspector.step({ messages: big, tools: [tool("a")] });
		expect(step.request).toBeDefined();
		expect(step.request!.text).not.toContain(secret);
		expect(step.request!.text.length).toBeLessThanOrEqual(INSPECT_REQUEST_STEP_MAX + 2_000);
		expect(step.request!.truncated).toBe(true);
	});
});
