import { afterEach, describe, expect, it, vi } from "vitest";
import { completeChatWithTools, usageFrom } from "./chat-tools.js";
import { fetchGenerationCost } from "./generation-cost.js";

describe("custo desconhecido", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("usageFrom sem usage.cost marca costUnknown (não vira 0)", () => {
		const usage = usageFrom({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
		expect(usage?.costUnknown).toBe(true);
		expect(usage?.costUsd).toBeUndefined();
		expect(usageFrom({ prompt_tokens: 1, cost: -1 })?.costUnknown).toBe(true);
	});

	it("usageFrom com custo (inclusive 0) não marca desconhecido", () => {
		expect(usageFrom({ prompt_tokens: 1, cost: 0.01 })).toMatchObject({ costUsd: 0.01 });
		expect(usageFrom({ prompt_tokens: 1, cost: 0.01 })?.costUnknown).toBeUndefined();
		expect(usageFrom({ prompt_tokens: 1, cost: 0 })).toMatchObject({ costUsd: 0 });
	});

	it("resposta sem bloco usage vem como custo desconhecido e guarda o id da geração", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(
					JSON.stringify({
						id: "gen-abc123",
						model: "m/x",
						choices: [{ message: { role: "assistant", content: "ok" } }],
					}),
					{ status: 200 },
				),
			),
		);
		const result = await completeChatWithTools({ messages: [], model: "m/x", apiKey: "k", tools: [] });
		expect(result.usage?.costUnknown).toBe(true);
		expect(result.generationId).toBe("gen-abc123");
	});

	it("id da geração inválido (com caracteres de URL) é descartado", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(
					JSON.stringify({ id: "../x?y=1", choices: [{ message: { role: "assistant", content: "ok" } }] }),
					{ status: 200 },
				),
			),
		);
		const result = await completeChatWithTools({ messages: [], model: "m/x", apiKey: "k", tools: [] });
		expect(result.generationId).toBeUndefined();
	});
});

describe("fetchGenerationCost", () => {
	const ok = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

	it("sucesso devolve total_cost e manda a chave só no header", async () => {
		const fetchFn = vi.fn(ok({ data: { total_cost: 0.0421 } }));
		const result = await fetchGenerationCost({ apiKey: "sk-secret", generationId: "gen-1", fetchFn });
		expect(result).toEqual({ ok: true, costUsd: 0.0421 });
		const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://openrouter.ai/api/v1/generation?id=gen-1");
		expect(url).not.toContain("sk-secret");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-secret");
	});

	it("404 devolve not_found sem lançar", async () => {
		const result = await fetchGenerationCost({ apiKey: "k", generationId: "gen-1", fetchFn: ok({}, 404) });
		expect(result).toEqual({ ok: false, reason: "not_found" });
	});

	it("timeout devolve timeout sem lançar", async () => {
		const fetchFn = (_url: string, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		const result = await fetchGenerationCost({ apiKey: "k", generationId: "gen-1", timeoutMs: 10, fetchFn });
		expect(result).toEqual({ ok: false, reason: "timeout" });
	});

	it("erro de rede, resposta inválida e id inválido nunca lançam", async () => {
		const boom = async () => {
			throw new Error("sk-secret vazou");
		};
		expect(await fetchGenerationCost({ apiKey: "k", generationId: "g", fetchFn: boom })).toEqual({ ok: false, reason: "network" });
		expect(await fetchGenerationCost({ apiKey: "k", generationId: "g", fetchFn: ok({ data: { total_cost: "x" } }) })).toEqual({ ok: false, reason: "invalid_response" });
		expect(await fetchGenerationCost({ apiKey: "k", generationId: "g", fetchFn: ok({}, 500) })).toEqual({ ok: false, reason: "http_error" });
		expect(await fetchGenerationCost({ apiKey: "k", generationId: "a/../b", fetchFn: ok({}) })).toEqual({ ok: false, reason: "invalid_id" });
	});
});
