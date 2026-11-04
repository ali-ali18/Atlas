import { describe, expect, it } from "vitest";
import { BASE_DELAY_MS, MAX_ATTEMPTS, MAX_DELAY_MS, STABLE_MS, backoffDelay, initialReconnect, msUntilRetry, reconnectStep, type ReconnectEvent, type ReconnectState } from "./computer-reconnect";

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
		expect(reconnectStep(initialReconnect, { t: "start" }, 0)).toEqual({ state: { phase: "connecting", attempts: 0, retryAt: null, connectedAt: null }, action: "connect" });
	});
	it("conectou: guarda o instante e ainda NÃO zera as tentativas", () => {
		const { state } = run({ phase: "connecting", attempts: 3, retryAt: null, connectedAt: null }, [[{ t: "connected" }, 5]]);
		expect(state).toEqual({ phase: "connected", attempts: 3, retryAt: null, connectedAt: 5 });
	});
	it("caiu: espera com recuo e só tenta de novo quando o relógio chega lá", () => {
		const out = run(initialReconnect, [
			[{ t: "connected" }, 0],
			[{ t: "dropped" }, 10_000],
			[{ t: "tick" }, 10_500],
			[{ t: "tick" }, 11_000],
		]);
		expect(out.actions).toEqual(["none", "none", "none", "connect"]);
		expect(out.state).toEqual({ phase: "connecting", attempts: 1, retryAt: null, connectedAt: null });
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
	it("servidor que aceita e fecha logo (conectar → cair em menos de 10 s) chega a desistir", () => {
		let state: ReconnectState = initialReconnect;
		let now = 0;
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			state = reconnectStep(state, { t: "connected" }, now).state;
			now += STABLE_MS - 1;
			state = reconnectStep(state, { t: "dropped" }, now).state;
			expect(state.phase).toBe("waiting");
			now = state.retryAt ?? now;
			state = reconnectStep(state, { t: "tick" }, now).state;
		}
		state = reconnectStep(state, { t: "connected" }, now).state;
		state = reconnectStep(state, { t: "dropped" }, now + 1).state;
		expect(state.phase).toBe("failed");
		expect(msUntilRetry(state, now)).toBeNull();
	});
	it("conexão estável (10 s) zera o contador na queda seguinte", () => {
		let state: ReconnectState = { phase: "connecting", attempts: 5, retryAt: null, connectedAt: null };
		state = reconnectStep(state, { t: "connected" }, 1000).state;
		state = reconnectStep(state, { t: "dropped" }, 1000 + STABLE_MS).state;
		expect(state).toEqual({ phase: "waiting", attempts: 1, retryAt: 1000 + STABLE_MS + 1000, connectedAt: null });
	});
	it("conexão que dura zera o contador (cai de novo e volta a esperar 1 s)", () => {
		const out = run(initialReconnect, [
			[{ t: "dropped" }, 0],
			[{ t: "tick" }, 1000],
			[{ t: "connected" }, 1500],
			[{ t: "dropped" }, 90_000],
		]);
		expect(out.state).toEqual({ phase: "waiting", attempts: 1, retryAt: 91_000, connectedAt: null });
	});
	it("'Tentar de novo' só age depois de desistir, e recomeça do zero", () => {
		const failed: ReconnectState = { phase: "failed", attempts: 7, retryAt: null, connectedAt: null };
		expect(reconnectStep(failed, { t: "retry" }, 0)).toEqual({ state: { phase: "connecting", attempts: 0, retryAt: null, connectedAt: null }, action: "connect" });
		expect(reconnectStep(initialReconnect, { t: "retry" }, 0).action).toBe("none");
	});
	it("erro fatal desiste na hora", () => {
		expect(reconnectStep(initialReconnect, { t: "fatal" }, 0).state.phase).toBe("failed");
	});
	it("evento atrasado depois de desistir é ignorado (conectado ou nova queda)", () => {
		const failed: ReconnectState = { phase: "failed", attempts: 7, retryAt: null, connectedAt: null };
		expect(reconnectStep(failed, { t: "connected" }, 0).state).toBe(failed);
		expect(reconnectStep(failed, { t: "dropped" }, 0).state).toBe(failed);
	});
	it("queda durante a espera não agenda duas vezes", () => {
		const waiting: ReconnectState = { phase: "waiting", attempts: 2, retryAt: 5000, connectedAt: null };
		expect(reconnectStep(waiting, { t: "dropped" }, 100).state).toBe(waiting);
	});
	it("msUntilRetry conta o que falta", () => {
		expect(msUntilRetry({ phase: "waiting", attempts: 1, retryAt: 5000, connectedAt: null }, 3000)).toBe(2000);
		expect(msUntilRetry({ phase: "waiting", attempts: 1, retryAt: 5000, connectedAt: null }, 9000)).toBe(0);
		expect(msUntilRetry(initialReconnect, 0)).toBeNull();
	});
	it("parar (tela fora de foco) não dispara retry: ignora queda, conexão, relógio e 'tentar de novo' atrasados", () => {
		const waiting: ReconnectState = { phase: "waiting", attempts: 2, retryAt: 5000, connectedAt: null };
		const stopped = reconnectStep(waiting, { t: "stop" }, 1000);
		expect(stopped).toEqual({ state: { phase: "stopped", attempts: 0, retryAt: null, connectedAt: null }, action: "none" });
		expect(msUntilRetry(stopped.state, 1000)).toBeNull();
		for (const event of [{ t: "tick" }, { t: "dropped" }, { t: "connected" }, { t: "fatal" }, { t: "retry" }] as ReconnectEvent[]) {
			const out = reconnectStep(stopped.state, event, 1e9);
			expect(out.state).toBe(stopped.state);
			expect(out.action).toBe("none");
		}
	});
	it("parar com a conexão aberta ou tentando também limpa tudo, e start recomeça do zero (esfera 'Conectando')", () => {
		for (const state of [initialReconnect, { phase: "connected", attempts: 0, retryAt: null, connectedAt: 5 } as ReconnectState, { phase: "failed", attempts: 7, retryAt: null, connectedAt: null } as ReconnectState]) {
			expect(reconnectStep(state, { t: "stop" }, 10).state.phase).toBe("stopped");
		}
		const stopped = reconnectStep(initialReconnect, { t: "stop" }, 0).state;
		expect(reconnectStep(stopped, { t: "start" }, 20)).toEqual({ state: { phase: "connecting", attempts: 0, retryAt: null, connectedAt: null }, action: "connect" });
	});
});
