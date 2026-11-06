import { describe, expect, it } from "vitest";
import { TOOL_RESULT_DISPLAY_CHARS, createSseMapper } from "./sse-map.js";

const result = (content: string) => ({ type: "tool_result" as const, data: { callId: "c1", name: "web_extract", status: "ok" as const, content } });

describe("sse-map: resumo do resultado de tool é só de exibição (auditoria F1, C8)", () => {
	it("corta em 2k caracteres com reticências, sem tocar o conteúdo original", () => {
		const mapper = createSseMapper({ runId: "r", model: "m" });
		const big = "x".repeat(24_000);
		const event = result(big);
		const [out] = mapper.map(event);
		expect(out).toMatchObject({ type: "tool_result", ok: true });
		const summary = (out as { summary: string }).summary;
		expect(summary).toHaveLength(TOOL_RESULT_DISPLAY_CHARS + 1);
		expect(summary.endsWith("…")).toBe(true);
		// o evento do kernel (que alimenta o contexto e o caderno) continua inteiro
		expect(event.data.content).toHaveLength(24_000);
	});

	it("resultado curto passa igual", () => {
		const [out] = createSseMapper({ runId: "r", model: "m" }).map(result("ok curto"));
		expect((out as { summary: string }).summary).toBe("ok curto");
	});
});
