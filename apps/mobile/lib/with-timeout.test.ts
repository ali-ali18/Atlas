import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "./with-timeout";

describe("withTimeout", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("promessa que nunca responde rejeita depois do prazo", async () => {
		const result = withTimeout(new Promise<string>(() => undefined), 15_000, () => new Error("demorou"));
		const assertion = expect(result).rejects.toThrow("demorou");
		await vi.advanceTimersByTimeAsync(14_999);
		await vi.advanceTimersByTimeAsync(2);
		await assertion;
	});
	it("resposta dentro do prazo passa e o relógio é cancelado", async () => {
		const result = withTimeout(Promise.resolve("ok"), 1000, () => new Error("demorou"));
		await expect(result).resolves.toBe("ok");
		expect(vi.getTimerCount()).toBe(0);
	});
	it("erro da própria promessa passa adiante sem virar timeout", async () => {
		const result = withTimeout(Promise.reject(new Error("falhou")), 1000, () => new Error("demorou"));
		await expect(result).rejects.toThrow("falhou");
		expect(vi.getTimerCount()).toBe(0);
	});
	it("resposta tardia depois do prazo é ignorada", async () => {
		let resolveLate: (v: string) => void = () => undefined;
		const late = new Promise<string>((resolve) => (resolveLate = resolve));
		const result = withTimeout(late, 1000, () => new Error("demorou"));
		const assertion = expect(result).rejects.toThrow("demorou");
		await vi.advanceTimersByTimeAsync(1001);
		await assertion;
		resolveLate("tarde");
	});
});
