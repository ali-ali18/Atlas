import { describe, expect, it } from "vitest";
import { changeSourceFor } from "./memory.js";

describe("changeSourceFor", () => {
	it("a revisão da conversa vira review e a reflexão diária vira reflection", () => {
		expect(changeSourceFor("memory-review")).toBe("review");
		expect(changeSourceFor("reflexao: diária")).toBe("reflection");
		expect(changeSourceFor("Reflexão: manual")).toBe("reflection");
	});

	it("a UI marca user; o resto (tool da conversa, vazio) é chat", () => {
		expect(changeSourceFor("user")).toBe("user");
		expect(changeSourceFor("agent-tool")).toBe("chat");
		expect(changeSourceFor(null)).toBe("chat");
		expect(changeSourceFor(undefined)).toBe("chat");
	});

	it("origin explícito vence o source", () => {
		expect(changeSourceFor("agent-tool", "reflection")).toBe("reflection");
		expect(changeSourceFor("memory-review", "user")).toBe("user");
	});
});
