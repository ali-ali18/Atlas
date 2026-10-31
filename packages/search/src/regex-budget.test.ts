import { describe, expect, it } from "vitest";
import type { AlertSource } from "@workspace/shared";
import { readAlertSource } from "./alert-source.js";
import { REGEX_WINDOW_BYTES, regexWindow, runRegexWithBudget } from "./regex-budget.js";

/** ReDoS: o padrão vem do modelo e o texto de um site de terceiros; a execução tem orçamento de tempo. */
const PATHOLOGICAL: Array<[string, string]> = [
	["\\d*\\d*\\d*\\d*x", "1".repeat(40_000)],
	["(\\d+)(\\d+)(\\d+)y", "1".repeat(30_000)],
	["(a+)+$", `${"a".repeat(40)}!`],
	["(.*)*z", "a".repeat(40_000)],
];

describe("runRegexWithBudget", () => {
	it.each(PATHOLOGICAL)("padrão patológico %s termina no orçamento, sem travar o processo", async (pattern, text) => {
		const started = Date.now();
		const run = await runRegexWithBudget(text, pattern, 100);
		expect(run.status).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(1500);
	});

	it("o laço de eventos segue livre enquanto o regex roda", async () => {
		let ticks = 0;
		const timer = setInterval(() => (ticks += 1), 10);
		await runRegexWithBudget("1".repeat(40_000), "\\d*\\d*\\d*\\d*x", 150);
		clearInterval(timer);
		expect(ticks).toBeGreaterThan(3);
	});

	it("o orçamento não conta a subida da thread (servidor ocupado não recusa regex simples)", async () => {
		// Subir a worker leva dezenas de ms mesmo ociosa (em produção ocupada passa dos 100 ms); o regex em si leva ~1 ms.
		// Com orçamento menor que a subida, antes dava "timeout" sem nem rodar o padrão.
		const run = await runRegexWithBudget(`${"x ".repeat(30_000)} Cotação R$ 21,34`, "R\\$\\s*([\\d.,]+)", 10);
		expect(run).toEqual({ status: "match", value: "21,34" });
	});

	it("padrão normal devolve o primeiro grupo, ausência e erro", async () => {
		expect(await runRegexWithBudget("Preço: R$ 1.299,00 hoje", "R\\$\\s*([\\d.,]+)")).toEqual({ status: "match", value: "1.299,00" });
		expect(await runRegexWithBudget("nada", "R\\$\\s*([\\d.,]+)")).toEqual({ status: "none" });
		expect(await runRegexWithBudget("x", "(")).toEqual({ status: "error" });
	});
});

describe("regexWindow", () => {
	it("corpo pequeno vai inteiro; corpo grande vira texto visível cortado em 64 KB", () => {
		expect(regexWindow("<b>R$ 10</b>")).toBe("<b>R$ 10</b>");
		const big = `<script>${"x".repeat(100_000)}</script><p>Preço R$ 449,90</p>${"<i>y</i>".repeat(30_000)}`;
		const window = regexWindow(big);
		expect(window.length).toBeLessThanOrEqual(REGEX_WINDOW_BYTES);
		expect(window).toContain("Preço R$ 449,90");
		expect(window).not.toContain("<script>");
	});
});

describe("regra de página com regex patológico na leitura", () => {
	it("vira leitura sem veredito com motivo honesto (e não trava)", async () => {
		const source: AlertSource = { type: "page", url: "https://loja.example.com/p", extract: { kind: "regex", pattern: "(\\d+)(\\d+)(\\d+)y" } };
		const body = "1".repeat(50_000);
		const started = Date.now();
		const result = await readAlertSource(source, { fetchFn: (async () => new Response(body)) as never, lookupFn: async () => ["93.184.216.34"], respectRobots: false });
		expect(result).toMatchObject({ ok: false, code: "parse", reason: expect.stringContaining("regex lenta") });
		expect(Date.now() - started).toBeLessThan(1500);
	});

	it("padrão estaticamente inseguro nem roda", async () => {
		const source: AlertSource = { type: "page", url: "https://loja.example.com/p", extract: { kind: "regex", pattern: "(a+)+$" } };
		const result = await readAlertSource(source, { fetchFn: (async () => new Response("aaaa")) as never, lookupFn: async () => ["93.184.216.34"], respectRobots: false });
		expect(result).toMatchObject({ ok: false, code: "parse" });
	});
});
