import { describe, expect, it, vi } from "vitest";
import { createHaptics } from "./haptics";

describe("createHaptics", () => {
	it("toca quando ligado e fica quieto quando desligado", () => {
		const play = vi.fn();
		const haptics = createHaptics(play);
		haptics.tap();
		expect(play).toHaveBeenCalledTimes(1);
		haptics.setEnabled(false);
		haptics.tap();
		expect(play).toHaveBeenCalledTimes(1);
		haptics.setEnabled(true);
		haptics.tap();
		expect(play).toHaveBeenCalledTimes(2);
	});
	it("falha do módulo (síncrona ou assíncrona) nunca estoura", async () => {
		const sync = createHaptics(() => {
			throw new Error("sem vibração");
		});
		expect(() => sync.tap()).not.toThrow();
		const rejecting = createHaptics(() => Promise.reject(new Error("sem vibração")));
		expect(() => rejecting.tap()).not.toThrow();
		await Promise.resolve();
	});
	it("começa no estado pedido", () => {
		expect(createHaptics(() => undefined, false).isEnabled()).toBe(false);
	});
});
