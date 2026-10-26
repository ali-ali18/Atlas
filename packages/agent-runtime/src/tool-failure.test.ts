import { describe, expect, it } from "vitest";
import type { ToolOutcome } from "./progress.js";
import {
	ARGUMENT_ERROR_HINT,
	classifyToolFailure,
	globalFailureAbort,
	isWebPageTool,
	perToolFailureStreak,
	withArgumentErrorHint,
} from "./tool-failure.js";

function fail(
	name: string,
	step: number,
	kind: "argument" | "other" = "other",
): ToolOutcome {
	return { name, argsKey: `${name}:${step}`, resultKey: "err:x", ok: false, step, kind };
}
function ok(name: string, step: number): ToolOutcome {
	return { name, argsKey: `${name}:${step}`, resultKey: "ok:x", ok: true, step };
}

describe("classifyToolFailure", () => {
	it.each([
		"[GitHub] Not Found (404)",
		"path does not point to a file or directory",
		"Validation Failed: sha is required",
		"invalid_args: title is required",
		"argumentos inválidos (JSON): Unexpected token",
		"Sheet not found",
	])("trata como erro de argumento: %s", (text) => {
		expect(classifyToolFailure(text)).toBe("argument");
	});

	it.each([
		"site fora do ar",
		"All scraping engines failed",
		"timeout de 30s",
		"HTTP 503 Service Unavailable",
		"",
	])("trata como falha comum: %s", (text) => {
		expect(classifyToolFailure(text)).toBe("other");
	});
});

describe("withArgumentErrorHint", () => {
	it("acrescenta a dica uma única vez", () => {
		const once = withArgumentErrorHint("Not Found (404)");
		expect(once).toContain(ARGUMENT_ERROR_HINT);
		expect(withArgumentErrorHint(once)).toBe(once);
	});
});

describe("perToolFailureStreak", () => {
	it("falhas paralelas no mesmo passo contam 1", () => {
		const outcomes = [fail("a", 0), fail("a", 0), fail("a", 0), fail("a", 0)];
		expect(perToolFailureStreak(outcomes, "a")).toBe(1);
	});

	it("passos seguidos somam; sucesso ou passo sem a tool zera", () => {
		expect(
			perToolFailureStreak([fail("a", 0), fail("a", 0), fail("a", 1)], "a"),
		).toBe(2);
		expect(
			perToolFailureStreak([fail("a", 0), ok("a", 1), fail("a", 2)], "a"),
		).toBe(1);
		expect(
			perToolFailureStreak([fail("a", 0), fail("b", 1), fail("a", 2)], "a"),
		).toBe(1);
	});

	it("erro de argumento não conta para a trava por tool", () => {
		const outcomes = [fail("a", 0, "argument"), fail("a", 1, "argument")];
		expect(perToolFailureStreak(outcomes, "a")).toBe(0);
	});

	it("sem step cada outcome é um grupo (checkpoint antigo)", () => {
		const legacy = (name: string): ToolOutcome => ({
			name,
			argsKey: name,
			resultKey: "err:x",
			ok: false,
		});
		expect(perToolFailureStreak([legacy("a"), legacy("a")], "a")).toBe(2);
	});
});

describe("globalFailureAbort", () => {
	const six = (kind: "argument" | "other") => [
		fail("a", 0, kind),
		fail("b", 1, kind),
		fail("c", 2, kind),
		fail("a", 3, kind),
		fail("b", 4, kind),
		fail("c", 5, kind),
	];

	it("6 passos seguidos com 3+ tools abortam", () => {
		expect(globalFailureAbort(six("other"))).toMatch(/6 ferramentas falharam/);
	});

	it("4 falhas paralelas no mesmo passo valem 1", () => {
		const batch = [fail("a", 0), fail("a", 0), fail("a", 0), fail("a", 0)];
		expect(globalFailureAbort(batch)).toBeNull();
		expect(
			globalFailureAbort([...batch, ...batch.map((o) => ({ ...o, step: 1 }))]),
		).toBeNull();
	});

	it("erro de argumento não conta", () => {
		expect(globalFailureAbort(six("argument"))).toBeNull();
	});

	it("passo só de erro de argumento é neutro (não zera nem soma)", () => {
		const outcomes = [
			fail("a", 0),
			fail("b", 1),
			fail("x", 2, "argument"),
			fail("c", 3),
			fail("a", 4),
			fail("b", 5),
			fail("c", 6),
		];
		expect(globalFailureAbort(outcomes)).toMatch(/6 ferramentas falharam/);
	});

	it("um sucesso no passo zera", () => {
		const outcomes = [...six("other").slice(0, 5), ok("d", 5), fail("c", 6)];
		expect(globalFailureAbort(outcomes)).toBeNull();
	});

	it("menos de 3 tools distintas não aborta", () => {
		const outcomes = Array.from({ length: 8 }, (_, i) =>
			fail(i % 2 ? "a" : "b", i),
		);
		expect(globalFailureAbort(outcomes)).toBeNull();
	});
});

describe("bloqueio por tool só conta falha do tipo other", () => {
	it("erro de argumento (link morto) é neutro: nem conta nem zera", () => {
		const outcomes = [fail("web_extract", 1, "argument"), fail("web_extract", 2, "argument"), fail("web_extract", 3, "argument")];
		expect(perToolFailureStreak(outcomes, "web_extract")).toBe(0);
		expect(perToolFailureStreak([fail("t", 1), fail("t", 2, "argument"), fail("t", 3)], "t")).toBe(2);
		expect(perToolFailureStreak([ok("t", 1), fail("t", 2), fail("t", 3, "argument"), fail("t", 4)], "t")).toBe(2);
	});

	it("resultado sintético é neutro para a trava por tool e para a global", () => {
		const synthetic = (name: string, step: number): ToolOutcome => ({ ...fail(name, step), synthetic: true });
		expect(perToolFailureStreak([fail("a", 1), fail("a", 2), synthetic("a", 3), synthetic("a", 4)], "a")).toBe(2);
		// A, A, A reais; 2 sintéticos de A; B; C: sem os sintéticos são 5 passos, abaixo de 6.
		const outcomes = [fail("a", 1), fail("a", 2), fail("a", 3), synthetic("a", 4), synthetic("a", 5), fail("b", 6), fail("c", 7)];
		expect(globalFailureAbort(outcomes)).toBeNull();
		// Controle: os mesmos passos como falha comum (comportamento antigo) abortariam.
		expect(globalFailureAbort(outcomes.map(({ synthetic: _s, ...rest }) => rest))).not.toBeNull();
	});

	it("sinceStep recomeça a contagem depois de um bloqueio expirado", () => {
		const outcomes = [fail("a", 1), fail("a", 2), fail("a", 3), fail("a", 9)];
		expect(perToolFailureStreak(outcomes, "a")).toBe(4);
		expect(perToolFailureStreak(outcomes, "a", 8)).toBe(1);
	});

	it("tools de leitura de página não ganham a dica de argumento", () => {
		expect(isWebPageTool("web_extract")).toBe(true);
		expect(isWebPageTool("mcp__firecrawl__firecrawl_scrape")).toBe(true);
		expect(isWebPageTool("mcp__github__get_file")).toBe(false);
	});
});
