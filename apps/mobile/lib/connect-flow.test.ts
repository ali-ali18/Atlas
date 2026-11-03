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
		/** AppState controlável: `script` diz o que emitir após o tick N de sleep (1 s cada). */
		function setup(script: Record<number, string>) {
			const { now, sleep } = clock();
			let listener: (state: string) => void = () => {};
			let unsubscribed = false;
			let tick = 0;
			return {
				now,
				unsubscribed: () => unsubscribed,
				appState: { subscribe: (cb: (state: string) => void) => { listener = cb; return () => void (unsubscribed = true); } },
				sleep: async (ms: number) => {
					await sleep(ms);
					tick += 1;
					if (script[tick]) listener(script[tick]!);
				},
			};
		}
		const opened = async () => ({ type: "opened" });

		it("volta ao app e fica: fechado só depois da janela de graça, com conferência final", async () => {
			const env = setup({ 2: "background", 3: "active" });
			const check = vi.fn(async () => false);
			const outcome = await runBrowserConnect("https://x", { open: opened, appState: env.appState, dismiss: () => {}, check, now: env.now, sleep: env.sleep, returnGraceMs: 5000 });
			expect(outcome).toBe("closed");
			// Voltou no segundo 3; fecha só no 8 (3 + 5 s de graça), sem parar no 1º segundo.
			expect(env.now()).toBe(8000);
			expect(check).toHaveBeenCalledTimes(8);
			expect(env.unsubscribed()).toBe(true);
		});
		it("ida e volta curta (2FA): sai de novo dentro da graça e segue esperando até conectar", async () => {
			const env = setup({ 2: "background", 3: "active", 5: "inactive", 6: "active" });
			let calls = 0;
			const outcome = await runBrowserConnect("https://x", { open: opened, appState: env.appState, dismiss: () => {}, check: async () => ++calls >= 10, now: env.now, sleep: env.sleep, returnGraceMs: 5000 });
			expect(outcome).toBe("connected");
			expect(calls).toBe(10);
		});
		it("saiu de novo dentro da graça: a contagem recomeça na última volta", async () => {
			const env = setup({ 2: "background", 3: "active", 5: "background", 6: "active" });
			const outcome = await runBrowserConnect("https://x", { open: opened, appState: env.appState, dismiss: () => {}, check: async () => false, now: env.now, sleep: env.sleep, returnGraceMs: 5000 });
			expect(outcome).toBe("closed");
			expect(env.now()).toBe(11000);
		});
		it("'opened' que volta conectado: conectado", async () => {
			const env = setup({ 1: "background", 2: "active" });
			let ticks = 0;
			const outcome = await runBrowserConnect("https://x", { open: opened, appState: env.appState, dismiss: () => {}, check: async () => ticks >= 2, now: env.now, sleep: async (ms) => { await env.sleep(ms); ticks += 1; } });
			expect(outcome).toBe("connected");
		});
		it("'opened' sem voltar ao app continua até o timeout", async () => {
			const env = setup({});
			const outcome = await runBrowserConnect("https://x", { open: opened, appState: env.appState, dismiss: () => {}, check: async () => false, now: env.now, sleep: env.sleep });
			expect(outcome).toBe("timeout");
			expect(env.now()).toBe(POLL_TIMEOUT_MS);
		});
		it("'active' sem ter saído do app não conta como retorno", async () => {
			const env = setup({ 1: "active", 2: "active", 3: "active" });
			const outcome = await runBrowserConnect("https://x", { open: opened, appState: env.appState, dismiss: () => {}, check: async () => false, now: env.now, sleep: env.sleep, returnGraceMs: 1000 });
			expect(outcome).toBe("timeout");
		});
		it("'cancel' e 'dismiss' (iOS) = fechado na hora", async () => {
			for (const type of ["cancel", "dismiss"]) {
				const { now, sleep } = clock();
				const outcome = await runBrowserConnect("https://x", { open: async () => ({ type }), dismiss: () => {}, check: async () => false, now, sleep });
				expect(outcome).toBe("closed");
			}
		});
	});

	describe("cancelamento e erros fatais", () => {
		it("cancelado: para sem fechar o navegador, mesmo que a conexão tenha acabado de entrar", async () => {
			const { now, sleep } = clock();
			const signal = { aborted: false };
			const dismiss = vi.fn();
			const outcome = await runBrowserConnect("https://x", { open: () => new Promise(() => {}), dismiss, signal, check: async () => { signal.aborted = true; return true; }, now, sleep });
			expect(outcome).toBe("cancelled");
			expect(dismiss).not.toHaveBeenCalled();
		});
		it("cancelado antes da primeira conferência: nem confere", async () => {
			const { now, sleep } = clock();
			const check = vi.fn(async () => false);
			const outcome = await runBrowserConnect("https://x", { open: () => new Promise(() => {}), dismiss: () => {}, signal: { aborted: true }, check, now, sleep });
			expect(outcome).toBe("cancelled");
			expect(check).not.toHaveBeenCalled();
		});
		it("401 na conferência sobe (para e deixa sair), mas outra falha continua", async () => {
			const { now, sleep } = clock();
			class Unauthorized extends Error {}
			await expect(runBrowserConnect("https://x", { open: () => new Promise(() => {}), dismiss: () => {}, check: async () => { throw new Unauthorized(); }, isFatal: (error) => error instanceof Unauthorized, now, sleep })).rejects.toBeInstanceOf(Unauthorized);
		});
	});
});
