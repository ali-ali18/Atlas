import { describe, expect, it } from "vitest";
import type { LlmMessage } from "@workspace/llm";
import { ACK_CONTINUE_PROMPT, appendAssistantAck, appendUserJoin, hasOpenToolBatch, openToolCallIds, USER_BURST_SEPARATOR } from "./transcript.js";

const call = (id: string) => ({ id, type: "function" as const, function: { name: "web_search", arguments: "{}" } });

describe("transcript.appendUserJoin", () => {
	it("anexa user depois de assistant", () => {
		const messages: LlmMessage[] = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
		expect(appendUserJoin(messages, "c")).toBe("appended");
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
	});

	it("anexa user depois dos tool results de um lote completo", () => {
		const messages: LlmMessage[] = [
			{ role: "user", content: "a" },
			{ role: "assistant", content: null, tool_calls: [call("1"), call("2")] },
			{ role: "tool", tool_call_id: "1", content: "r1" },
			{ role: "tool", tool_call_id: "2", content: "r2" },
		];
		expect(appendUserJoin(messages, "nota")).toBe("appended");
		expect(messages.at(-1)).toEqual({ role: "user", content: "nota" });
	});

	it("burst collapse: duas user seguidas viram uma, na ordem, com separador", () => {
		const messages: LlmMessage[] = [{ role: "assistant", content: "ok" }];
		appendUserJoin(messages, "primeira");
		expect(appendUserJoin(messages, "segunda")).toBe("merged");
		expect(appendUserJoin(messages, "terceira")).toBe("merged");
		expect(messages).toHaveLength(2);
		expect(messages[1]!.content).toBe(["primeira", "segunda", "terceira"].join(USER_BURST_SEPARATOR));
	});

	it("burst collapse preserva image_ref da mensagem mesclada", () => {
		const messages: LlmMessage[] = [{ role: "user", content: "veja" }];
		appendUserJoin(messages, [{ type: "text", text: "e isto" }, { type: "image_ref", artifactId: "img1" }]);
		expect(messages).toHaveLength(1);
		expect(messages[0]!.content).toEqual([
			{ type: "text", text: "veja" },
			{ type: "text", text: `${USER_BURST_SEPARATOR}e isto` },
			{ type: "image_ref", artifactId: "img1" },
		]);
	});

	it("alternância: user no meio do lote de tools é adiado (não escreve nada)", () => {
		const messages: LlmMessage[] = [
			{ role: "user", content: "a" },
			{ role: "assistant", content: null, tool_calls: [call("1"), call("2")] },
			{ role: "tool", tool_call_id: "1", content: "r1" },
		];
		const before = structuredClone(messages);
		expect(hasOpenToolBatch(messages)).toBe(true);
		expect(openToolCallIds(messages)).toEqual(["2"]);
		expect(appendUserJoin(messages, "nota")).toBe("deferred");
		expect(messages).toEqual(before);
		// Fronteira seguinte: o resultado chegou, a nota entra DEPOIS dele.
		messages.push({ role: "tool", tool_call_id: "2", content: "r2" });
		expect(appendUserJoin(messages, "nota")).toBe("appended");
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "user"]);
	});

	it("lote sem nenhum result ainda está aberto", () => {
		const messages: LlmMessage[] = [{ role: "assistant", content: null, tool_calls: [call("1")] }];
		expect(appendUserJoin(messages, "x")).toBe("deferred");
	});
});

describe("transcript.appendAssistantAck", () => {
	it("anexa a resposta e uma continuação user: o histórico nunca termina em assistant", () => {
		const messages: LlmMessage[] = [{ role: "user", content: "nota" }];
		expect(appendAssistantAck(messages, "Boa noite!")).toBe(true);
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(messages[2]!.content).toBe(ACK_CONTINUE_PROMPT);
	});

	it("não escreve com lote de tools aberto nem se a última não for user", () => {
		const open: LlmMessage[] = [
			{ role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "x", arguments: "{}" } }] },
		];
		expect(appendAssistantAck(open, "oi")).toBe(false);
		expect(open).toHaveLength(1);
		const endsAssistant: LlmMessage[] = [{ role: "assistant", content: "ok" }];
		expect(appendAssistantAck(endsAssistant, "oi")).toBe(false);
	});
});
