import { describe, expect, it } from "vitest";
import { parseNativeComputerMode, supportsNativeComputerTool } from "./computer-native.js";

describe("parseNativeComputerMode", () => {
	it("padrão off e valores inválidos viram off", () => {
		expect(parseNativeComputerMode(undefined)).toBe("off");
		expect(parseNativeComputerMode("")).toBe("off");
		expect(parseNativeComputerMode("sim")).toBe("off");
	});
	it("aceita on e shadow sem diferenciar caixa", () => {
		expect(parseNativeComputerMode("ON")).toBe("on");
		expect(parseNativeComputerMode(" shadow ")).toBe("shadow");
	});
});

describe("supportsNativeComputerTool", () => {
	it("Claude e computer-use da OpenAI sim", () => {
		expect(supportsNativeComputerTool("anthropic/claude-sonnet-5.5")).toBe(true);
		expect(supportsNativeComputerTool("anthropic/claude-3.7-sonnet")).toBe(true);
		expect(supportsNativeComputerTool("anthropic/claude-opus-4")).toBe(true);
		expect(supportsNativeComputerTool("openai/computer-use-preview")).toBe(true);
	});
	it("outros modelos não", () => {
		expect(supportsNativeComputerTool("openai/gpt-6-luna")).toBe(false);
		expect(supportsNativeComputerTool("anthropic/claude-3-haiku")).toBe(false);
		expect(supportsNativeComputerTool(undefined)).toBe(false);
	});
});
