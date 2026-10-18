import { describe, expect, it } from "vitest";
import type { LlmMessage } from "@workspace/llm";
import { collapseOldToolGroups, stubLargeToolOutputs } from "./hygiene.js";

const ref =
	"[Full result stored as artifact:art-7 (30000 chars). It stays in context for now; if it is collapsed later, re-read it with artifact_read instead of repeating the call.]";
const big = `${"x".repeat(30_000)}\n${ref}`;
const call = (id: string): LlmMessage => ({
	role: "assistant",
	content: null,
	tool_calls: [{ id, type: "function", function: { name: "web_extract", arguments: "{}" } }],
});
const conversation = (first = big): LlmMessage[] => [
	{ role: "system", content: "s" },
	{ role: "user", content: "task" },
	call("c1"),
	{ role: "tool", tool_call_id: "c1", content: first },
	call("c2"),
	{ role: "tool", tool_call_id: "c2", content: "ok" },
];

describe("L3: a referência do resultado guardado sobrevive à higiene", () => {
	it("o corte de resultado grande mantém a linha de referência no fim", () => {
		const out = stubLargeToolOutputs(conversation());
		const content = String(out[3]!.content);
		expect(content).toContain("[truncado:");
		expect(content.endsWith(ref)).toBe(true);
		expect(content.length).toBeLessThan(8_800);
		expect(stubLargeToolOutputs(out)[3]!.content).toBe(content);
	});

	it("o colapso do grupo antigo também a mantém", () => {
		const { messages } = collapseOldToolGroups(conversation());
		const content = String(messages[3]!.content);
		expect(content.startsWith("[higiene:")).toBe(true);
		expect(content).toContain("artifact:art-7");
		expect(content).toContain("artifact_read");
	});

	it("resultado sem referência segue como antes", () => {
		const out = stubLargeToolOutputs(conversation("y".repeat(30_000)));
		expect(String(out[3]!.content)).toMatch(/\[truncado: 30000 caracteres\]$/);
	});
});
