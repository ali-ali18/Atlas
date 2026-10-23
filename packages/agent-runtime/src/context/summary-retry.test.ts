import { OpenRouterError } from "@workspace/llm";
import { describe, expect, it } from "vitest";
import { TransientRunError } from "../errors.js";
import { callSummaryWithRetry, isRetryableSummaryError, SUMMARY_RETRY_DELAY_MS, SUMMARY_TOTAL_BUDGET_MS } from "./summary-retry.js";

/** Relógio falso: cada chamada avança o tempo que a tentativa "levou". */
function clock() {
	let t = 0;
	return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("callSummaryWithRetry", () => {
	it("502 do provedor (resposta vazia): tenta de novo uma vez, depois da espera, e devolve o resumo", async () => {
		const c = clock();
		const slept: number[] = [];
		const timeouts: number[] = [];
		const retried: unknown[] = [];
		let calls = 0;
		const result = await callSummaryWithRetry(
			async (timeoutMs) => {
				timeouts.push(timeoutMs);
				calls += 1;
				c.advance(40_000);
				if (calls === 1) throw new OpenRouterError("OpenRouter returned an empty assistant message", 502);
				return "resumo";
			},
			{ now: c.now, sleep: async (ms) => { slept.push(ms); c.advance(ms); }, onRetry: (error) => retried.push(error) },
		);
		expect(result).toBe("resumo");
		expect(calls).toBe(2);
		expect(slept).toEqual([SUMMARY_RETRY_DELAY_MS]);
		expect(retried).toHaveLength(1);
		// a segunda tentativa fica com o que sobra do prazo total (não mais um prazo cheio)
		expect(timeouts).toEqual([60_000, SUMMARY_TOTAL_BUDGET_MS - 40_000 - SUMMARY_RETRY_DELAY_MS]);
	});

	it("falha de novo: sobe o erro da segunda tentativa (sem terceira)", async () => {
		let calls = 0;
		await expect(
			callSummaryWithRetry(async () => { calls += 1; throw new OpenRouterError(`upstream ${calls}`, 503); }, { sleep: async () => undefined }),
		).rejects.toThrow("upstream 2");
		expect(calls).toBe(2);
	});

	it("recusa da requisição (4xx) não repete", async () => {
		let calls = 0;
		await expect(
			callSummaryWithRetry(async () => { calls += 1; throw new OpenRouterError("context length exceeded", 400); }, { sleep: async () => undefined }),
		).rejects.toThrow("context length");
		expect(calls).toBe(1);
	});

	it("primeira tentativa estourou o prazo: sem tempo para outra dentro do total, não repete", async () => {
		const c = clock();
		let calls = 0;
		const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
		await expect(
			callSummaryWithRetry(async (timeoutMs) => { calls += 1; c.advance(timeoutMs); throw timeout; }, { now: c.now, sleep: async () => undefined }),
		).rejects.toBe(timeout);
		expect(calls).toBe(1);
	});
});

describe("isRetryableSummaryError", () => {
	it("passageiro: 5xx, 429, rede, resposta vazia; definitivo: 4xx", () => {
		expect(isRetryableSummaryError(new OpenRouterError("bad gateway", 502))).toBe(true);
		expect(isRetryableSummaryError(new OpenRouterError("slow down", 429))).toBe(true);
		expect(isRetryableSummaryError(new TypeError("fetch failed"))).toBe(true);
		expect(isRetryableSummaryError(new TransientRunError("empty summary"))).toBe(true);
		expect(isRetryableSummaryError(new OpenRouterError("invalid model", 404))).toBe(false);
	});
});
