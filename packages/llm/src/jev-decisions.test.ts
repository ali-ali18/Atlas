import { describe, expect, it, vi } from "vitest";
import { askJev, evaluateMcpWithJev, JEV_MCP_MODEL } from "./jev-decisions.js";

const state = { userRequest: "Crie um evento", toolName: "create_event", toolDescription: "Cria evento", actionClass: "write" as const, arguments: { summary: "Reunião" } };

describe("Jev Decisions API", () => {
	it("envia perguntas tipadas ao endpoint correto e lê probabilidades", async () => {
		const fetchFn = vi.fn(async () => new Response(JSON.stringify({
			model: JEV_MCP_MODEL,
			answers: { alignment: { type: "noul", noul: 0.95 }, external_instruction: { type: "noul", noul: 0.02 } },
			usage: { input_tokens: 123 },
		}), { status: 200 }));
		const result = await evaluateMcpWithJev({ apiKey: "test-key", state, fetchFn });
		expect(result).toMatchObject({ alignment: 0.95, externalInstruction: 0.02, inputTokens: 123 });
		const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
		expect(JSON.parse(String(init.body))).toMatchObject({ model: JEV_MCP_MODEL, state, questions: { alignment: { type: "noul" }, external_instruction: { type: "noul" } } });
	});

	it.each([NaN, -0.1, 1.1, "0.9"])("rejeita probabilidade inválida %s", async (noul) => {
		const fetchFn = vi.fn(async () => new Response(JSON.stringify({ model: JEV_MCP_MODEL, answers: { alignment: { type: "noul", noul }, external_instruction: { type: "noul", noul: 0 } } }), { status: 200 }));
		await expect(evaluateMcpWithJev({ apiKey: "test", state, fetchFn })).rejects.toThrow();
	});

	it("não expõe o corpo de erro do provedor", async () => {
		const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: { message: "secret from request" } }), { status: 429 }));
		await expect(evaluateMcpWithJev({ apiKey: "test", state, fetchFn })).rejects.toThrow("Jev decision request failed");
	});

	it("askJev aceita perguntas arbitrárias e devolve probabilidades por chave", async () => {
		const fetchFn = vi.fn(async () => new Response(JSON.stringify({
			model: JEV_MCP_MODEL,
			answers: { a: { type: "noul", noul: 0.9 }, b: { type: "noul", noul: 0.1 } },
		}), { status: 200 }));
		const q = { instructions: "?", criteria: { true: "t", false: "f" } };
		const result = await askJev({ apiKey: "k", state: { x: 1 }, questions: { a: q, b: q }, fetchFn, timeoutMs: 500 });
		expect(result.answers).toEqual({ a: 0.9, b: 0.1 });
		const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(String(init.body)).questions.a).toMatchObject({ type: "noul", instructions: "?" });
	});

	it("askJev rejeita quando falta uma resposta pedida", async () => {
		const fetchFn = vi.fn(async () => new Response(JSON.stringify({ model: JEV_MCP_MODEL, answers: { a: { type: "noul", noul: 0.5 } } }), { status: 200 }));
		const q = { instructions: "?", criteria: { true: "t", false: "f" } };
		await expect(askJev({ apiKey: "k", state: {}, questions: { a: q, b: q }, fetchFn })).rejects.toThrow();
	});
});
