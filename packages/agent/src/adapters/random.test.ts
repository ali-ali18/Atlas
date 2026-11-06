import { describe, expect, it } from "vitest";
import { createSystemRandom } from "./random.js";

describe("createSystemRandom", () => {
	it("devolve o tamanho pedido e valores diferentes a cada chamada", () => {
		const r = createSystemRandom();
		const a = r.bytes(16);
		const b = r.bytes(16);
		expect(a).toBeInstanceOf(Uint8Array);
		expect(a).toHaveLength(16);
		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
		expect(r.bytes(0)).toHaveLength(0);
	});
	it("recusa tamanho inválido", () => {
		expect(() => createSystemRandom().bytes(-1)).toThrow(RangeError);
		expect(() => createSystemRandom().bytes(1.5)).toThrow(RangeError);
	});
});
