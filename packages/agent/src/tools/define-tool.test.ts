import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeToolContext } from "../testing.js";
import { defineTool, isDefinedTool } from "./define-tool.js";

const input = z.object({ query: z.string(), limit: z.number().int().optional() });

const base = {
	name: "web_search",
	description: "Search the web. Use for fresh facts; not for files the user already shared.",
	inputSchema: input,
	effect: "read" as const,
	execute: ({ query }: z.output<typeof input>) => ({ ok: true as const, summary: `found ${query}` }),
};

describe("defineTool", () => {
	it("efeito é obrigatório no tipo", () => {
		const { effect: _effect, ...semEfeito } = base;
		// @ts-expect-error sem `effect` não compila
		expect(() => defineTool(semEfeito)).toThrow(/missing or unknown effect/);
	});

	it("falha em runtime com efeito ausente ou desconhecido (tool montada por JS/MCP)", () => {
		const loose = defineTool as (def: unknown) => unknown;
		const { effect: _effect, ...semEfeito } = base;
		expect(() => loose(semEfeito)).toThrow(/Declare one of: read, draft/);
		expect(() => loose({ ...base, effect: "launch_missiles" })).toThrow(/unknown effect "launch_missiles"/);
	});

	it("rejeita nome fora de snake_case e descrição vazia", () => {
		expect(() => defineTool({ ...base, name: "WebSearch" })).toThrow(/invalid tool name/);
		expect(() => defineTool({ ...base, description: "  " })).toThrow(/empty description/);
	});

	it("rejeita campo desconhecido listando os aceitos, sem executar", async () => {
		let ran = false;
		const tool = defineTool({ ...base, execute: () => ((ran = true), { ok: true, summary: "x" }) });
		const result = await tool.run({ query: "a", limite: 3 }, fakeToolContext());
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Unknown field(s) for web_search: limite") });
		expect(result.ok === false && result.hint).toBe("Accepted fields: query, limit.");
		expect(ran).toBe(false);
	});

	it("rejeita tipo inválido com o caminho do campo, e args que não são objeto", async () => {
		const tool = defineTool(base);
		const bad = await tool.run({ query: 42 }, fakeToolContext());
		expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("query:") });
		expect(await tool.run(null, fakeToolContext())).toMatchObject({ ok: false, error: expect.stringContaining("expected an object") });
	});

	it("devolve ok:true com summary e recibo", async () => {
		const tool = defineTool({
			...base,
			effect: "write_internal",
			execute: () => ({ ok: true, summary: "criada", receipt: { what: "rotina criada", externalId: "r1" } }),
		});
		expect(await tool.run({ query: "q" }, fakeToolContext())).toEqual({ ok: true, summary: "criada", receipt: { what: "rotina criada", externalId: "r1" } });
	});

	it("ok:true com texto de erro não passa no tipo nem em runtime", async () => {
		// @ts-expect-error `error` não existe no resultado de sucesso
		const typed = defineTool({ ...base, execute: () => ({ ok: true, summary: "x", error: "falhou" }) });
		expect(await typed.run({ query: "q" }, fakeToolContext())).toMatchObject({ ok: false, error: expect.stringContaining("malformed result") });
		const loose = defineTool({ ...base, execute: (() => ({ ok: true })) as never });
		expect(await loose.run({ query: "q" }, fakeToolContext())).toMatchObject({ ok: false });
	});

	it("falha de execução vira ok:false com a mensagem real", async () => {
		const tool = defineTool({ ...base, execute: () => Promise.reject(new Error("timeout no servidor")) });
		expect(await tool.run({ query: "q" }, fakeToolContext())).toEqual({ ok: false, error: "timeout no servidor" });
	});

	it("effectForArgs muda a classe pela chamada; args inválidos usam a base", () => {
		const tool = defineTool({
			name: "calendar_event",
			description: "Create or read calendar events.",
			inputSchema: z.object({ action: z.enum(["list", "create"]) }),
			effect: "write_external",
			effectForArgs: ({ action }) => (action === "list" ? "read" : "write_external"),
			riskFacts: ({ action }) => ({ target: action }),
			execute: () => ({ ok: true, summary: "ok" }),
		});
		expect(tool.effectFor({ action: "list" })).toBe("read");
		expect(tool.effectFor({ action: "create" })).toBe("write_external");
		expect(tool.effectFor({ action: "?" })).toBe("write_external");
		expect(tool.riskFactsFor({ action: "create" })).toEqual({ target: "create" });
		expect(tool.riskFactsFor({ nope: 1 })).toBeUndefined();
	});

	it("effectForArgs com classe desconhecida lança", () => {
		const tool = defineTool({ ...base, effectForArgs: (() => "oops") as never });
		expect(() => tool.effectFor({ query: "q" })).toThrow(/unknown effect/);
	});

	it("gera o LlmToolSpec com JSON Schema, estável byte a byte", () => {
		const tool = defineTool(base);
		const spec = tool.toLlmToolSpec();
		expect(spec.name).toBe("web_search");
		expect(spec.inputSchema).toMatchObject({ type: "object", required: ["query"], properties: { query: { type: "string" } } });
		expect(JSON.stringify(spec.inputSchema)).not.toContain("$schema");
		expect(JSON.stringify(spec.inputSchema)).not.toContain("9007199254740991");
		expect(JSON.stringify(tool.toLlmToolSpec())).toBe(JSON.stringify(spec));
	});

	it("isDefinedTool só aceita o que veio de defineTool", () => {
		const tool = defineTool(base);
		expect(isDefinedTool(tool)).toBe(true);
		expect(isDefinedTool({ ...tool })).toBe(false);
	});

	it("endsTurn é falso por padrão", () => {
		expect(defineTool(base).endsTurn).toBe(false);
		expect(defineTool({ ...base, endsTurn: true }).endsTurn).toBe(true);
	});
});
