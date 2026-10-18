import { describe, it } from "node:test";
import assert from "node:assert";
import { pollMcpOAuthConnection } from "./mcp-oauth-wait";

const never = new Promise<never>(() => {});

function sequence(...states: Array<{ status: string; lastError?: string | null }>) {
	let i = 0;
	return async () => states[Math.min(i++, states.length - 1)];
}

describe("pollMcpOAuthConnection", () => {
	it("popup fecha cedo e depois conecta: ok", async () => {
		const result = await pollMcpOAuthConnection({
			popup: Promise.resolve({ ok: false, closed: true, error: "Login não concluído." }),
			load: sequence({ status: "pending" }, { status: "pending" }, { status: "connected" }),
			intervalMs: 5,
			timeoutMs: 1000,
		});
		assert.deepStrictEqual(result, { ok: true });
	});

	it("mensagem ok e conectado: ok", async () => {
		const result = await pollMcpOAuthConnection({
			popup: Promise.resolve({ ok: true }),
			load: sequence({ status: "connected" }),
			intervalMs: 5,
		});
		assert.strictEqual(result.ok, true);
	});

	it("mensagem ok mas status ainda não final: segue esperando", async () => {
		const result = await pollMcpOAuthConnection({
			popup: Promise.resolve({ ok: true }),
			load: sequence({ status: "connecting" }, { status: "connected" }),
			intervalMs: 5,
		});
		assert.strictEqual(result.ok, true);
	});

	it("tempo esgotado: erro", async () => {
		const result = await pollMcpOAuthConnection({
			popup: Promise.resolve({ ok: false, closed: true }),
			load: sequence({ status: "pending" }),
			intervalMs: 5,
			timeoutMs: 40,
		});
		assert.deepStrictEqual(result, { ok: false, error: "Login não concluído." });
	});

	it("erro do callback mostra lastError", async () => {
		const result = await pollMcpOAuthConnection({
			popup: Promise.resolve({ ok: false, error: "genérico" }),
			load: sequence({ status: "error", lastError: "access_denied" }),
			intervalMs: 5,
		});
		assert.deepStrictEqual(result, { ok: false, error: "access_denied" });
	});

	it("cancelar interrompe", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		const result = await pollMcpOAuthConnection({
			popup: never,
			load: sequence({ status: "pending" }),
			intervalMs: 5,
			signal: controller.signal,
		});
		assert.strictEqual(result.cancelled, true);
	});

	it("falha de rede passageira não derruba", async () => {
		let n = 0;
		const result = await pollMcpOAuthConnection({
			popup: never,
			load: async () => {
				if (n++ === 0) throw new Error("rede");
				return { status: "connected" };
			},
			intervalMs: 5,
		});
		assert.strictEqual(result.ok, true);
	});
});
