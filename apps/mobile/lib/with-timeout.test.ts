import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeoutError, withTimeout } from "./with-timeout";

afterEach(() => vi.useRealTimers());

describe("withTimeout", () => {
	it("devolve o resultado quando vem a tempo", async () => {
		await expect(withTimeout(Promise.resolve(7), 1000)).resolves.toBe(7);
	});
	it("repassa o erro da operação", async () => {
		await expect(withTimeout(Promise.reject(new Error("x")), 1000)).rejects.toThrow("x");
	});
	it("estoura com TimeoutError e chama onTimeout (aborta a rede)", async () => {
		vi.useFakeTimers();
		const onTimeout = vi.fn();
		const pending = withTimeout(new Promise<never>(() => undefined), 500, onTimeout);
		const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutError);
		await vi.advanceTimersByTimeAsync(501);
		await assertion;
		expect(onTimeout).toHaveBeenCalledTimes(1);
	});
	it("não chama onTimeout quando terminou antes", async () => {
		vi.useFakeTimers();
		const onTimeout = vi.fn();
		await withTimeout(Promise.resolve(1), 500, onTimeout);
		await vi.advanceTimersByTimeAsync(1000);
		expect(onTimeout).not.toHaveBeenCalled();
	});
});
