import { describe, expect, it } from "vitest";
import { buildTestPrMessage, parseTestPrInput, resolveTestPrForm } from "./test-pr.js";

describe("parseTestPrInput", () => {
	it("URL completa, com sufixos e maiúsculas", () => {
		expect(parseTestPrInput("https://github.com/Octo/Hello/pull/42")).toEqual({ repo: "octo/hello", number: 42 });
		expect(parseTestPrInput("  https://github.com/octo/hello/pull/7/files?diff=split#x ")).toEqual({ repo: "octo/hello", number: 7 });
		expect(parseTestPrInput("http://www.github.com/octo/hello.js/pull/3")).toEqual({ repo: "octo/hello.js", number: 3 });
	});
	it("dono/nome#número, #número e número", () => {
		expect(parseTestPrInput("octo/hello#9")).toEqual({ repo: "octo/hello", number: 9 });
		expect(parseTestPrInput("octo/hello #9")).toEqual({ repo: "octo/hello", number: 9 });
		expect(parseTestPrInput("#42")).toEqual({ number: 42 });
		expect(parseTestPrInput("42")).toEqual({ number: 42 });
	});
	it("recusa o que não é PR", () => {
		for (const text of ["", "abc", "0", "#0", "https://github.com/octo/hello", "https://evil.com/octo/hello/pull/1", "https://github.com/octo/hello/issues/1", "1; rm -rf /", "12345678901"]) {
			expect(parseTestPrInput(text), text).toBeNull();
		}
	});
});

describe("mensagem", () => {
	it("pede checkout, instalação, testes, CI e veredito de merge", () => {
		const text = buildTestPrMessage({ repo: "octo/hello", number: 42 });
		expect(text).toBe("Testa a PR #42 de octo/hello: faça checkout, instale, rode testes/typecheck/lint/build, veja o CI e diga se pode dar merge.");
		expect(text).not.toMatch(/atlas/i);
	});
	it("o formulário usa o repositório da URL colada, senão o campo", () => {
		expect(resolveTestPrForm("", "https://github.com/octo/hello/pull/42")).toMatchObject({ ok: true, repo: "octo/hello", number: 42 });
		expect(resolveTestPrForm("acme/site", "#5")).toMatchObject({ ok: true, repo: "acme/site", number: 5 });
		expect(resolveTestPrForm("acme/site", "https://github.com/octo/hello/pull/1")).toMatchObject({ repo: "octo/hello" });
		expect(resolveTestPrForm("", "#5")).toMatchObject({ ok: false, error: expect.stringContaining("repositório") });
		expect(resolveTestPrForm("acme/site", "")).toMatchObject({ ok: false, error: expect.stringContaining("número") });
	});
});
