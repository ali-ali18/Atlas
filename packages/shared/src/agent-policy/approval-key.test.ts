import { describe, expect, it } from "vitest";
import { approvalPayload, approvalToken, canonicalJson } from "./approval-key.js";

describe("canonicalJson", () => {
	it("ignora a ordem das chaves em todos os níveis", () => {
		const a = { b: 1, a: { y: [1, { d: 1, c: 2 }], x: "z" } };
		const b = { a: { x: "z", y: [1, { c: 2, d: 1 }] }, b: 1 };
		expect(canonicalJson(a)).toBe(canonicalJson(b));
	});
	it("preserva a ordem dos arrays", () => {
		expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
	});
	it("omite undefined em objeto e vira null em array", () => {
		expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
		expect(canonicalJson([undefined])).toBe("[null]");
	});
	it("distingue tipos", () => {
		expect(canonicalJson({ a: "1" })).not.toBe(canonicalJson({ a: 1 }));
		expect(canonicalJson(null)).toBe("null");
	});
	it("recusa número não finito e tipos não serializáveis", () => {
		expect(() => canonicalJson(Number.NaN)).toThrow();
		expect(() => canonicalJson(() => 1)).toThrow();
		expect(() => canonicalJson(1n)).toThrow();
	});
});

describe("approvalToken", () => {
	const hash = (s: string) => `h(${s})`;
	it("é estável para a mesma ação e muda com qualquer argumento", () => {
		const t = approvalToken("send_email", { to: ["a@x.com"], body: "oi" }, hash);
		expect(approvalToken("send_email", { body: "oi", to: ["a@x.com"] }, hash)).toBe(t);
		expect(approvalToken("send_email", { body: "oi", to: ["a@x.com", "b@x.com"] }, hash)).not.toBe(t);
		expect(approvalToken("send_mail", { body: "oi", to: ["a@x.com"] }, hash)).not.toBe(t);
	});
	it("payload carrega tool e args", () => {
		expect(approvalPayload("t", { a: 1 })).toBe('{"args":{"a":1},"toolName":"t"}');
	});
});
