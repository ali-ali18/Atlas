import { describe, expect, it, vi } from "vitest";
import { decidePoll, POLL_TIMEOUT_MS, runBrowserConnect } from "./connect-flow";

describe("decidePoll", () => {
	const base = { connected: false, browserClosed: false, startedAt: 0, now: 0 };
	it("continua até o limite e para exatamente nele", () => {
		expect(decidePoll({ ...base, now: POLL_TIMEOUT_MS - 1 })).toBe("continue");
		expect(decidePoll({ ...base, now: POLL_TIMEOUT_MS })).toBe("timeout");
	});
	it("conectado ganha de fechado e de tempo", () => {
		expect(decidePoll({ ...base, connected: true, browserClosed: true, now: POLL_TIMEOUT_MS * 2 })).toBe("connected");
	});
	it("fechou sem conectar: para sem erro", () => {
		expect(decidePoll({ ...base, browserClosed: true })).toBe("closed");
	});
	it("respeita um limite próprio", () => {
		expect(decidePoll({ ...base, now: 5, timeoutMs: 5 })).toBe("timeout");
	});
});

function clock() {
	let now = 0;
	return { now: () => now, sleep: async (ms: number) => void (now += ms) };
}

describe("runBrowserConnect", () => {
	it("conecta na terceira conferência, fecha o navegador e não espera o fim", async () => {
		const { now, sleep } = clock();
		const dismiss = vi.fn();
		const checks = [false, false, true];
		const outcome = await runBrowserConnect("https://x", { open: () => new Promise(() => {}), dismiss, check: async () => checks.shift() ?? true, now, sleep });
		expect(outcome).toBe("connected");
		expect(dismiss).toHaveBeenCalledOnce();
		expect(now()).toBe(3000);
	});
	it("navegador fechado sem conectar: faz uma última conferência e termina como 'closed'", async () => {
		const { now, sleep } = clock();
		const dismiss = vi.fn();
		const check = vi.fn(async () => false);
		const outcome = await runBrowserConnect("https://x", { open: () => Promise.resolve({ type: "dismiss" }), dismiss, check, now, sleep });
		expect(outcome).toBe("closed");
		expect(check).toHaveBeenCalled();
		expect(dismiss).not.toHaveBeenCalled();
	});
	it("fechou mas a conexão já tinha entrado: conectado", async () => {
		const { now, sleep } = clock();
		const outcome = await runBrowserConnect("https://x", { open: () => Promise.resolve(), dismiss: () => {}, check: async () => true, now, sleep });
		expect(outcome).toBe("connected");
	});
	it("estoura em 90 s com o navegador aberto", async () => {
		const { now, sleep } = clock();
		const outcome = await runBrowserConnect("https://x", { open: () => new Promise(() => {}), dismiss: () => {}, check: async () => false, now, sleep });
		expect(outcome).toBe("timeout");
		expect(now()).toBe(POLL_TIMEOUT_MS);
	});
	it("falha de rede na conferência não derruba: segue tentando", async () => {
		const { now, sleep } = clock();
		let calls = 0;
		const outcome = await runBrowserConnect("https://x", {
			open: () => new Promise(() => {}),
			dismiss: () => {},
			check: async () => {
				calls += 1;
				if (calls < 3) throw new Error("rede");
				return true;
			},
			now,
			sleep,
		});
		expect(outcome).toBe("connected");
		expect(calls).toBe(3);
	});
	it("erro ao abrir o navegador conta como fechado", async () => {
		const { now, sleep } = clock();
		const outcome = await runBrowserConnect("https://x", { open: () => Promise.reject(new Error("x")), dismiss: () => {}, check: async () => false, now, sleep });
		expect(outcome).toBe("closed");
	});

	describe("Android: openBrowserAsync resolve ao abrir", () => {
		function appState() {
			let listener: (state: string) => void = () => {};
			let unsubscribed = false;
			return { source: { subscribe: (cb: (state: string) => void) => { listener = cb; return () => void (unsubscribed = true); } }, emit: (state: string) => listener(state), wasUnsubscribed: () => unsubscribed };
		}
		it("'opened' + background + active = fechado, com conferência final", async () => {
			const { now, sleep } = clock();
			const app = appState();
			let ticks = 0;
			const check = vi.fn(async () => false);
			const outcome = await runBrowserConnect("https://x", {
				open: async () => ({ type: "opened" }),
				appState: app.source,
				dismiss: () => {},
				check,
				now,
				sleep: async (ms) => {
					await sleep(ms);
					ticks += 1;
					if (ticks === 2) app.emit("background");
					if (ticks === 3) app.emit("active");
				},
			});
			expect(outcome).toBe("closed");
			// Não parou no 1º segundo: esperou o retorno ao app e ainda conferiu uma última vez.
			expect(check.mock.calls.length).toBeGreaterThanOrEqual(3);
			expect(app.wasUnsubscribed()).toBe(true);
		});
		it("'opened' que volta conectado: conectado", async () => {
			const { now, sleep } = clock();
			const app = appState();
			let ticks = 0;
			const outcome = await runBrowserConnect("https://x", { open: async () => ({ type: "opened" }), appState: app.source, dismiss: () => {}, check: async () => ticks >= 2, now, sleep: async (ms) => { await sleep(ms); ticks += 1; if (ticks === 1) app.emit("background"); if (ticks === 2) app.emit("active"); } });
			expect(outcome).toBe("connected");
		});
		it("'opened' sem voltar ao app continua até o timeout", async () => {
			const { now, sleep } = clock();
			const app = appState();
			const outcome = await runBrowserConnect("https://x", { open: async () => ({ type: "opened" }), appState: app.source, dismiss: () => {}, check: async () => false, now, sleep });
			expect(outcome).toBe("timeout");
			expect(now()).toBe(POLL_TIMEOUT_MS);
		});
		it("'active' sem ter saído do app não conta como retorno", async () => {
			const { now, sleep } = clock();
			const app = appState();
			app.emit("active");
			const outcome = await runBrowserConnect("https://x", { open: async () => ({ type: "opened" }), appState: app.source, dismiss: () => {}, check: async () => false, now, sleep: async (ms) => { app.emit("active"); await sleep(ms); } });
			expect(outcome).toBe("timeout");
		});
		it("'cancel' e 'dismiss' (iOS) = fechado", async () => {
			for (const type of ["cancel", "dismiss"]) {
				const { now, sleep } = clock();
				const outcome = await runBrowserConnect("https://x", { open: async () => ({ type }), dismiss: () => {}, check: async () => false, now, sleep });
				expect(outcome).toBe("closed");
			}
		});
	});
});
