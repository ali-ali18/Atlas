import { describe, expect, it } from "vitest";
import { BASE_DELAY_MS, MAX_ATTEMPTS, MAX_DELAY_MS, backoffDelay, initialReconnect, msUntilRetry, reconnectStep, type ReconnectEvent, type ReconnectState } from "./computer-reconnect";

function run(start: ReconnectState, steps: Array<[ReconnectEvent, number]>) {
	let state = start;
	const actions: string[] = [];
	for (const [event, now] of steps) {
		const out = reconnectStep(state, event, now);
		state = out.state;
		actions.push(out.action);
	}
	return { state, actions };
}

describe("recuo exponencial", () => {
	it("1 s, 2 s, 4 s, 8 s, e no máximo 15 s", () => {
		expect([1, 2, 3, 4, 5, 6].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, MAX_DELAY_MS, MAX_DELAY_MS]);
		expect(backoffDelay(0)).toBe(0);
		expect(BASE_DELAY_MS).toBe(1000);
	});
});

describe("máquina de reconexão", () => {
	it("começa conectando e pede a conexão", () => {
		expect(reconnectStep(initialReconnect, { t: "start" }, 0)).toEqual({ state: { phase: "connecting", attempts: 0, retryAt: null }, action: "connect" });
	});
	it("conectou: zera as tentativas", () => {
		const { state } = run({ phase: "connecting", attempts: 3, retryAt: null }, [[{ t: "connected" }, 5]]);
		expect(state).toEqual({ phase: "connected", attempts: 0, retryAt: null });
	});
	it("caiu: espera com recuo e só tenta de novo quando o relógio chega lá", () => {
		const out = run(initialReconnect, [
			[{ t: "connected" }, 0],
			[{ t: "dropped" }, 10_000],
			[{ t: "tick" }, 10_500],
			[{ t: "tick" }, 11_000],
		]);
		expect(out.actions).toEqual(["none", "none", "none", "connect"]);
		expect(out.state).toEqual({ phase: "connecting", attempts: 1, retryAt: null });
	});
	it("quedas seguidas dobram a espera", () => {
		let state: ReconnectState = initialReconnect;
		const waits: number[] = [];
		let now = 0;
		for (let i = 0; i < 4; i++) {
			state = reconnectStep(state, { t: "dropped" }, now).state;
			waits.push((state.retryAt ?? 0) - now);
			now = state.retryAt ?? now;
			state = reconnectStep(state, { t: "tick" }, now).state;
		}
		expect(waits).toEqual([1000, 2000, 4000, 8000]);
	});
	it("depois do limite desiste (failed) e não agenda mais nada", () => {
		let state: ReconnectState = initialReconnect;
		let now = 0;
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			state = reconnectStep(state, { t: "dropped" }, now).state;
			expect(state.phase).toBe("waiting");
			now = state.retryAt ?? now;
			state = reconnectStep(state, { t: "tick" }, now).state;
		}
		const last = reconnectStep(state, { t: "dropped" }, now);
		expect(last.state.phase).toBe("failed");
		expect(msUntilRetry(last.state, now)).toBeNull();
		expect(reconnectStep(last.state, { t: "tick" }, now + 1e9).action).toBe("none");
	});
	it("conexão que dura zera o contador (cai de novo e volta a esperar 1 s)", () => {
		const out = run(initialReconnect, [
			[{ t: "dropped" }, 0],
			[{ t: "tick" }, 1000],
			[{ t: "connected" }, 1500],
			[{ t: "dropped" }, 90_000],
		]);
		expect(out.state).toEqual({ phase: "waiting", attempts: 1, retryAt: 91_000 });
	});
	it("'Tentar de novo' só age depois de desistir, e recomeça do zero", () => {
		const failed: ReconnectState = { phase: "failed", attempts: 7, retryAt: null };
		expect(reconnectStep(failed, { t: "retry" }, 0)).toEqual({ state: { phase: "connecting", attempts: 0, retryAt: null }, action: "connect" });
		expect(reconnectStep(initialReconnect, { t: "retry" }, 0).action).toBe("none");
	});
	it("erro fatal desiste na hora", () => {
		expect(reconnectStep(initialReconnect, { t: "fatal" }, 0).state.phase).toBe("failed");
	});
	it("evento atrasado depois de desistir é ignorado (conectado ou nova queda)", () => {
		const failed: ReconnectState = { phase: "failed", attempts: 7, retryAt: null };
		expect(reconnectStep(failed, { t: "connected" }, 0).state).toBe(failed);
		expect(reconnectStep(failed, { t: "dropped" }, 0).state).toBe(failed);
	});
	it("queda durante a espera não agenda duas vezes", () => {
		const waiting: ReconnectState = { phase: "waiting", attempts: 2, retryAt: 5000 };
		expect(reconnectStep(waiting, { t: "dropped" }, 100).state).toBe(waiting);
	});
	it("msUntilRetry conta o que falta", () => {
		expect(msUntilRetry({ phase: "waiting", attempts: 1, retryAt: 5000 }, 3000)).toBe(2000);
		expect(msUntilRetry({ phase: "waiting", attempts: 1, retryAt: 5000 }, 9000)).toBe(0);
		expect(msUntilRetry(initialReconnect, 0)).toBeNull();
	});
});
