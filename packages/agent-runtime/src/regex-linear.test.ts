import { describe, expect, it } from "vitest";
import { countRequestSteps } from "./context/difficulty.js";
import { extractResultRef, stripResultRef } from "./context/result-store.js";
import { createLessonInjector } from "./lessons.js";
import { looksEmptyResult } from "./mcp/empty-hint.js";
import { extractShownUrl } from "./tools/browser-claims.js";
import { compactErrorDetail } from "./tools/sandbox-errors.js";

// Regressão dos alertas CodeQL "Polynomial regular expression": entrada hostil responde rápido
// e entrada normal mantém o resultado de antes.
const N = 50_000;
const LIMIT_MS = 200;

function timed<T>(fn: () => T): { value: T; ms: number } {
	const start = performance.now();
	const value = fn();
	return { value, ms: performance.now() - start };
}

describe("regex lineares (ReDoS)", () => {
	it("difficulty: muitas linhas vazias", () => {
		const { ms } = timed(() => countRequestSteps(`${"\n".repeat(N)}x`));
		expect(ms).toBeLessThan(LIMIT_MS);
		expect(countRequestSteps("1) abrir\n2) fechar\n\n  - extra\ntexto - solto")).toBe(3);
		expect(countRequestSteps("- a\n- b")).toBe(2);
	});

	it("result-store: marcadores repetidos sem fechamento", () => {
		const hostile = "[Full result stored as artifact:- (0 chars)".repeat(10_000);
		const { ms } = timed(() => extractResultRef(hostile));
		expect(ms).toBeLessThan(LIMIT_MS);
		const ref = "[Full result stored as artifact:abc_1 (4500 chars). Read the rest with artifact_read.]";
		expect(extractResultRef(`corpo\n${ref}`)).toEqual({ id: "abc_1", chars: 4500, line: ref });
		expect(stripResultRef(`corpo\n${ref}`)).not.toContain("Full result stored");
	});

	it("lessons: cabeçalho enorme não trava e a chave normal é lida", () => {
		const injector = createLessonInjector([]);
		const hostile = `════ LIÇÕES APRENDIDAS ${"[\\".repeat(N)}`;
		const { ms } = timed(() => injector.seed([{ role: "system", content: hostile }]));
		expect(ms).toBeLessThan(LIMIT_MS);
	});

	it("empty-hint: rodapés [..] empilhados", () => {
		const { ms } = timed(() => looksEmptyResult(`${"\n[]".repeat(N)}x`));
		expect(ms).toBeLessThan(LIMIT_MS);
		expect(looksEmptyResult('{"data":[]}\n[origem: bling]\n[dado externo]')).toBe(true);
		expect(looksEmptyResult('{"data":[{"id":1}]}\n[origem: bling]')).toBe(false);
		expect(looksEmptyResult("[]")).toBe(true);
	});

	it("browser-claims: '(about:' repetido sem fechar", () => {
		for (const prefix of ["(about:", "(chrome://", "(http://"]) {
			const { ms } = timed(() => extractShownUrl(prefix.repeat(N)));
			expect(ms).toBeLessThan(LIMIT_MS);
		}
		expect(extractShownUrl("Título (https://site.com/pagina)")).toBe("https://site.com/pagina");
		expect(extractShownUrl("(about:blank)")).toBe("about:blank");
		expect(extractShownUrl("sem url")).toBeNull();
	});

	it("sandbox-errors: muitas quebras de linha", () => {
		const { ms } = timed(() => compactErrorDetail(`${"\n".repeat(N)}x`));
		expect(ms).toBeLessThan(LIMIT_MS);
		expect(compactErrorDetail("falhou\n\n  Call log:\n  - tentando")).toBe("falhou");
	});
});
