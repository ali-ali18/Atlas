import { describe, expect, it } from "vitest";
import { parseSseBlock } from "./sse.js";

describe("parseSseBlock", () => {
	it("lê id e data", () => {
		const parsed = parseSseBlock(
			'id: 12\ndata: {"type":"assistant_delta","id":"a","delta":"x"}',
		);
		expect(parsed.id).toBe(12);
		expect(parsed.event).toEqual({
			type: "assistant_delta",
			id: "a",
			delta: "x",
		});
	});

	it("deduplica pela presença do id", () => {
		const parsed = parseSseBlock("id: 3\ndata: not-json");
		expect(parsed.id).toBe(3);
		expect(parsed.event).toBeUndefined();
	});
});
