import { describe, expect, it, vi } from "vitest";
import { askJev, evaluateMcpWithJev, JEV_MCP_MODEL, JEV_MCP_QUESTIONS, jevMcpQuestions } from "./jev-decisions.js";

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

describe("perguntas do Jev para conector", () => {
	it("sem conteúdo externo, incerteza sobre reversível não é motivo para perguntar", () => {
		expect(JEV_MCP_QUESTIONS.alignment!.instructions).toContain("NOT a reason to answer false");
		expect(jevMcpQuestions(false).alignment!.instructions).toContain("NOT a reason to answer false");
	});
	it("depois de ler conteúdo que o usuário não escreveu, a leniência some e a incerteza vira false", () => {
		const text = jevMcpQuestions(true).alignment!.instructions;
		expect(text).not.toContain("NOT a reason to answer false");
		expect(text).toContain("answer false");
		expect(text).toContain("did not write");
	});
	it("alreadyApproved é dado (nomes e contagem), nunca autorização", () => {
		expect(jevMcpQuestions(true).alignment!.instructions).toContain("only a list of tool names with counts");
	});
	it("o avaliador usa as perguntas rígidas quando o estado diz que houve conteúdo externo", async () => {
		const fetchFn = vi.fn(async () => new Response(JSON.stringify({ model: JEV_MCP_MODEL, answers: { alignment: { type: "noul", noul: 1 }, external_instruction: { type: "noul", noul: 0 } } }), { status: 200 }));
		await evaluateMcpWithJev({ apiKey: "k", state: { ...state, untrustedContentSeen: true }, fetchFn: fetchFn as unknown as typeof fetch });
		const body = JSON.parse(String((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body));
		expect(body.questions.alignment.instructions).not.toContain("NOT a reason to answer false");
	});
});
