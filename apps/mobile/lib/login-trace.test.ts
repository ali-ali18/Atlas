import { describe, expect, it } from "vitest";
import { TRACE_MAX_LINES, appendTrace, createLoginTrace, describeLink, parseTrace } from "./login-trace";

describe("describeLink", () => {
	it("mostra esquema, host e caminho e só os nomes dos parâmetros", () => {
		const url = "exp://u.expo.dev/abc/group/g1/--/?token=tok_SEGREDO123456789&state=0123456789abcdef";
		const text = describeLink(url);
		expect(text).toBe("exp://u.expo.dev/abc/group/g1/--/ [token,state]");
		expect(text).not.toContain("SEGREDO");
		expect(text).not.toContain("0123456789abcdef");
	});
	it("vazio e link sem parâmetros", () => {
		expect(describeLink(null)).toBe("(vazio)");
		expect(describeLink("atlas:///")).toBe("atlas:///");
	});
	it("corta link muito longo", () => {
		expect(describeLink(`exp://${"a".repeat(200)}`).length).toBeLessThanOrEqual(91);
	});
});

describe("appendTrace e parseTrace", () => {
	it("mantém só as últimas linhas", () => {
		let lines: string[] = [];
		for (let i = 0; i < TRACE_MAX_LINES + 5; i++) lines = appendTrace(lines, `passo ${i}`, 0);
		expect(lines).toHaveLength(TRACE_MAX_LINES);
		expect(lines.at(-1)).toContain(`passo ${TRACE_MAX_LINES + 4}`);
	});
	it("ignora conteúdo inválido", () => {
		expect(parseTrace("{")).toEqual([]);
		expect(parseTrace('{"a":1}')).toEqual([]);
		expect(parseTrace('["a",2,"b"]')).toEqual(["a", "b"]);
		expect(parseTrace(null)).toEqual([]);
	});
});

describe("createLoginTrace", () => {
	it("junta o que estava guardado com o que veio depois e grava", async () => {
		let stored: string | null = JSON.stringify(["antes"]);
		const trace = createLoginTrace({ get: async () => stored, set: async (value) => void (stored = value) }, () => 0);
		trace.add("depois");
		await trace.load();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(trace.get()).toEqual(["antes", expect.stringContaining("depois")]);
		expect(parseTrace(stored)).toEqual(trace.get());
	});
	it("avisa quem assina e limpa", async () => {
		let calls = 0;
		const trace = createLoginTrace({ get: async () => null, set: async () => undefined });
		const off = trace.subscribe(() => calls++);
		trace.add("x");
		trace.clear();
		off();
		expect(calls).toBeGreaterThanOrEqual(2);
		expect(trace.get()).toEqual([]);
	});
	it("falha do armazenamento não quebra", async () => {
		const trace = createLoginTrace({ get: async () => Promise.reject(new Error("x")), set: async () => Promise.reject(new Error("y")) });
		trace.add("ok");
		await trace.load();
		expect(trace.get()).toHaveLength(1);
	});
});
