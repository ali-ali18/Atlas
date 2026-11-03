import { describe, expect, it } from "vitest";
import { TimeoutError, withTimeout } from "./with-timeout";

/** Relógio manual: guarda o que foi agendado e dispara quando o teste mandar. */
function manualClock() {
	const pending: { run: () => void; cancelled: boolean }[] = [];
	return {
		schedule: (run: () => void) => {
			const entry = { run, cancelled: false };
			pending.push(entry);
			return () => {
				entry.cancelled = true;
			};
		},
		fire: () => {
			for (const entry of pending) if (!entry.cancelled) entry.run();
		},
		pending,
	};
}

describe("withTimeout", () => {
	it("devolve o valor quando o pedido termina antes do limite, e cancela o relógio", async () => {
		const clock = manualClock();
		await expect(withTimeout(Promise.resolve(7), 1000, clock.schedule)).resolves.toBe(7);
		expect(clock.pending[0]?.cancelled).toBe(true);
	});
	it("repassa a falha do pedido", async () => {
		const clock = manualClock();
		await expect(withTimeout(Promise.reject(new Error("caiu")), 1000, clock.schedule)).rejects.toThrow("caiu");
	});
	it("rejeita com TimeoutError quando o pedido passa do limite; a resposta tardia é ignorada", async () => {
		const clock = manualClock();
		let finish: (value: number) => void = () => undefined;
		const slow = new Promise<number>((resolve) => {
			finish = resolve;
		});
		const result = withTimeout(slow, 1000, clock.schedule);
		clock.fire();
		await expect(result).rejects.toBeInstanceOf(TimeoutError);
		finish(1);
		await expect(result).rejects.toBeInstanceOf(TimeoutError);
	});
});
