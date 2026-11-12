import { describe, expect, it } from "vitest";
import { normalizeApiKey } from "./api-key.js";

describe("normalizeApiKey", () => {
	it("aceita chave plausível e tira espaços das pontas", () => {
		expect(normalizeApiKey("  sk-ant-api03-ABCDEFGH  ")).toBe("sk-ant-api03-ABCDEFGH");
	});
	it("recusa não-texto, curta, longa, com espaço ou controle", () => {
		expect(normalizeApiKey(42)).toBeNull();
		expect(normalizeApiKey("curta")).toBeNull();
		expect(normalizeApiKey("a".repeat(513))).toBeNull();
		expect(normalizeApiKey("tem espaco no meio")).toBeNull();
		expect(normalizeApiKey("tem\u0007controle")).toBeNull();
	});
});
