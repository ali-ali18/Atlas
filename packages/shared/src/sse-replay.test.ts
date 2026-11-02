import { describe, expect, it } from "vitest";
import { createSseReplayGuard } from "./sse-replay.js";

describe("createSseReplayGuard", () => {
	it("aceita ids crescentes e descarta repetidos ou atrasados", () => {
		const guard = createSseReplayGuard();
		expect(guard.accept(1)).toBe(true);
		expect(guard.accept(2)).toBe(true);
		expect(guard.accept(2)).toBe(false);
		expect(guard.accept(1)).toBe(false);
		expect(guard.cursor).toBe(2);
	});

	it("começa do cursor informado", () => {
		const guard = createSseReplayGuard(10);
		expect(guard.accept(10)).toBe(false);
		expect(guard.accept(11)).toBe(true);
	});

	it("evento sem id ou com id 0 sempre passa e não move o cursor", () => {
		const guard = createSseReplayGuard(5);
		expect(guard.accept(undefined)).toBe(true);
		expect(guard.accept(0)).toBe(true);
		expect(guard.cursor).toBe(5);
	});
});
