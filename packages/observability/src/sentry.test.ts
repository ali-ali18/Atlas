import { describe, expect, it } from "vitest";
import { initSentry, sentryEnabled } from "./sentry.js";

describe("initSentry", () => {
	it("sem SENTRY_DSN não liga nada", () => {
		expect(initSentry("api", {})).toBe(false);
		expect(initSentry("api", { SENTRY_DSN: "   " })).toBe(false);
		expect(sentryEnabled()).toBe(false);
	});
});
