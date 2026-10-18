import { describe, expect, it } from "vitest";
import { COMPACT_TAIL_KEEP, selectCompactTail } from "./compact.js";

type Msg = { role: string; content: string };

function convo(n: number): Msg[] {
	return Array.from({ length: n }, (_, i) => ({
		role: i % 2 === 0 ? "user" : "assistant",
		content: `m${i}`,
	}));
}

describe("selectCompactTail", () => {
	it("retorna tudo quando cabe na cauda", () => {
		expect(selectCompactTail(convo(3))).toHaveLength(3);
	});

	it("corta para as últimas N preservando a ordem", () => {
		const out = selectCompactTail(convo(10), 4);
		expect(out.map((m) => m.content)).toEqual(["m6", "m7", "m8", "m9"]);
	});

	it("usa o default de 6", () => {
		expect(selectCompactTail(convo(40))).toHaveLength(COMPACT_TAIL_KEEP);
	});

	it("keep<=0 retorna vazio", () => {
		expect(selectCompactTail(convo(5), 0)).toEqual([]);
	});
});
