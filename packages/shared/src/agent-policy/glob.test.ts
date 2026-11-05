import { describe, expect, it } from "vitest";
import { globMatch } from "./glob.js";

describe("globMatch", () => {
	it.each([
		["email_send", "email_send", true],
		["email_*", "email_send", true],
		["*", "", true],
		["mcp__*__send*", "mcp__gmail__send_message", true],
		["*_send", "email_send_all", false],
		["e?ail", "email", true],
		["e?ail", "eail", false],
		["a*b*c", "aXXbYYc", true],
		["a*b*c", "aXXbYY", false],
		["", "", true],
		["", "x", false],
	])("%s vs %s", (pattern, name, expected) => {
		expect(globMatch(pattern, name)).toBe(expected);
	});
	it("não explode em padrão patológico", () => {
		expect(globMatch("a*a*a*a*a*a*a*a*b", "a".repeat(5000))).toBe(false);
	});
});
