import { describe, expect, it } from "vitest";
import {
	abortForConsecutiveFailures,
	checkRepeat,
	hasSuccessfulToolEvidence,
	hasVerifiableProgress,
	isNoProgressLoop,
	parseProgressEvaluation,
	sameToolFailureStreak,
	toolArgsKey,
	toolResultKey,
	type ToolOutcome,
} from "./progress.js";

function fail(name: string, tag: string): ToolOutcome {
	return {
		name,
		argsKey: toolArgsKey(name, { tag }),
		resultKey: toolResultKey(`erro ${tag}`, false),
		ok: false,
	};
}

describe("sameToolFailureStreak", () => {
	it("conta só o fim da lista e zera com outro resultado no meio", () => {
		expect(sameToolFailureStreak([fail("a", "1"), fail("a", "2"), fail("a", "3")], "a")).toBe(3);
		expect(
			sameToolFailureStreak(
				[fail("a", "1"), fail("b", "1"), fail("a", "2"), fail("a", "3")],
				"a",
			),
		).toBe(2);
		expect(
			sameToolFailureStreak(
				[
					fail("a", "1"),
					{
						name: "a",
						argsKey: toolArgsKey("a", {}),
						resultKey: toolResultKey("ok", true),
						ok: true,
					},
					fail("a", "2"),
				],
				"a",
			),
		).toBe(1);
	});
});

describe("abortForConsecutiveFailures", () => {
	it("só aborta com 6 seguidas de 3+ tools", () => {
		const six = [
			fail("a", "1"),
			fail("b", "1"),
			fail("c", "1"),
			fail("a", "2"),
			fail("b", "2"),
			fail("c", "2"),
		];
		expect(abortForConsecutiveFailures(six)).toMatch(/6 ferramentas falharam/);
		expect(
			abortForConsecutiveFailures([
				fail("a", "1"),
				fail("a", "2"),
				fail("a", "3"),
				fail("a", "4"),
				fail("a", "5"),
				fail("a", "6"),
			]),
		).toBeNull();
		expect(abortForConsecutiveFailures(six.slice(0, 5))).toBeNull();
	});
});

describe("checkRepeat", () => {
	it("warn na primeira, abort na segunda", () => {
		const argsKey = toolArgsKey("navigate", { url: "https://a.com" });
		const resultKey = toolResultKey("mesmo texto", true);
		const outcomes: ToolOutcome[] = [
			{ name: "navigate", argsKey, resultKey, ok: true },
			{ name: "navigate", argsKey, resultKey, ok: true },
		];
		expect(checkRepeat(outcomes, argsKey, resultKey, new Set())).toBe("warn");
		expect(
			checkRepeat(outcomes, argsKey, resultKey, new Set([`${argsKey}|${resultKey}`])),
		).toBe("abort");
		expect(checkRepeat(outcomes, "outra", resultKey, new Set())).toBe("ok");
	});
});

describe("parseProgressEvaluation", () => {
	it("aceita JSON válido", () => {
		expect(
			parseProgressEvaluation(
				'{"concluded": false, "summary": "", "continueReason": "falta a aba"}',
			),
		).toEqual({
			concluded: false,
			summary: "",
			continueReason: "falta a aba",
		});
	});

	it("JSON inválido ou concluded sem summary retorna null", () => {
		expect(parseProgressEvaluation("não é json")).toBeNull();
		expect(
			parseProgressEvaluation('{"concluded": true, "summary": ""}'),
		).toBeNull();
		expect(parseProgressEvaluation('{"summary": "x"}')).toBeNull();
	});
});

describe("isNoProgressLoop", () => {
	it("não trata ler → rolar → ler como loop", () => {
		const read1 = {
			name: "browser_text",
			argsKey: toolArgsKey("browser_text", {}),
			resultKey: toolResultKey("titulo A", true),
			ok: true,
		};
		const scroll = {
			name: "scroll",
			argsKey: toolArgsKey("scroll", { dy: 400 }),
			resultKey: toolResultKey("ok", true),
			ok: true,
		};
		const read2 = {
			name: "browser_text",
			argsKey: toolArgsKey("browser_text", {}),
			resultKey: toolResultKey("titulo B mais conteúdo", true),
			ok: true,
		};
		expect(isNoProgressLoop([read1, scroll, read2], new Set()).result).toBe("ok");
	});

	it("detecta a mesma ação e o mesmo resultado 3x: warn na primeira, abort na segunda", () => {
		const same = {
			name: "navigate",
			argsKey: toolArgsKey("navigate", { url: "https://a.com" }),
			resultKey: toolResultKey("https://a.com", true),
			ok: true,
		};
		const result1 = isNoProgressLoop([same, same, same], new Set());
		expect(result1.result).toBe("warn");
		expect(result1.reason).toMatch(/navigate/);
		expect(result1.loopKey).toBe(`repeat|navigate|${same.argsKey}`);

		// Second time with the same loop key: abort
		const loopKey = `repeat|navigate|${same.argsKey}`;
		const result2 = isNoProgressLoop([same, same, same], new Set([loopKey]));
		expect(result2.result).toBe("abort");
		expect(result2.reason).toMatch(/navigate/);
		expect(result2.loopKey).toBe(loopKey);
	});

	it("detecta alternância A-B-A-B-A-B com os mesmos args e resultados: warn depois abort", () => {
		const a = {
			name: "click",
			argsKey: toolArgsKey("click", { x: 10, y: 10 }),
			resultKey: toolResultKey("mesmo botão", true),
			ok: true,
		};
		const b = {
			name: "screenshot",
			argsKey: toolArgsKey("screenshot", {}),
			resultKey: toolResultKey("mesma tela", true),
			ok: true,
		};
		// Período 2 com só 2 repetições (4 elementos): não detecta
		const result0 = isNoProgressLoop([a, b, a, b], new Set());
		expect(result0.result).toBe("ok");
		expect(result0.reason).toBeNull();

		// Período 2 com 3 repetições (6 elementos): detecta
		const result1 = isNoProgressLoop([a, b, a, b, a, b], new Set());
		expect(result1.result).toBe("warn");
		expect(result1.reason).toMatch(/Alternating/);
		expect(result1.loopKey).toBeDefined();
		expect(result1.loopKey).toContain("alternate|");

		// Second time with same loop key: abort
		const result2 = isNoProgressLoop([a, b, a, b, a, b], new Set([result1.loopKey!]));
		expect(result2.result).toBe("abort");
		expect(result2.reason).toMatch(/Alternating/);
		expect(result2.loopKey).toBe(result1.loopKey);
	});

	it("detecta ciclo de período 2 (A,B,A,B,A,B) com args e resultados idênticos após 3 repetições", () => {
		const a = {
			name: "find",
			argsKey: toolArgsKey("find", { text: "x" }),
			resultKey: toolResultKey("não encontrado", true),
			ok: true,
		};
		const b = {
			name: "click",
			argsKey: toolArgsKey("click", { selector: "button" }),
			resultKey: toolResultKey("clicado", true),
			ok: true,
		};
		// Ciclo: A, B, A, B (período 2, só 2 repetições) - não deve detectar
		const result1 = isNoProgressLoop([a, b, a, b], new Set());
		expect(result1.result).toBe("ok");
		expect(result1.reason).toBeNull();

		// Ciclo: A, B, A, B, A, B (período 2, 3 repetições) - deve detectar
		const result2 = isNoProgressLoop([a, b, a, b, a, b], new Set());
		expect(result2.result).toBe("warn");
		expect(result2.reason).toMatch(/Alternating.*find.*click/);
		expect(result2.loopKey).toBeDefined();
		expect(result2.loopKey).toContain("alternate|");
	});

	it("detecta ciclo de período 3 (A,B,C,A,B,C,A,B,C): warn primeiro, depois abort", () => {
		const a = {
			name: "navigate",
			argsKey: toolArgsKey("navigate", { url: "page" }),
			resultKey: toolResultKey("loaded", true),
			ok: true,
		};
		const b = {
			name: "click",
			argsKey: toolArgsKey("click", { selector: "btn" }),
			resultKey: toolResultKey("click ok", true),
			ok: true,
		};
		const c = {
			name: "screenshot",
			argsKey: toolArgsKey("screenshot", {}),
			resultKey: toolResultKey("screenshot ok", true),
			ok: true,
		};
		// Ciclo: A, B, C, A, B, C (período 3, só 2 repetições) - não detecta
		const result0 = isNoProgressLoop([a, b, c, a, b, c], new Set());
		expect(result0.result).toBe("ok");
		expect(result0.reason).toBeNull();

		// Ciclo: A, B, C, A, B, C, A, B, C (período 3, 3 repetições) - detecta
		const result1 = isNoProgressLoop([a, b, c, a, b, c, a, b, c], new Set());
		expect(result1.result).toBe("warn");
		expect(result1.reason).toMatch(/Period-3 loop/);
		expect(result1.reason).toMatch(/navigate.*click.*screenshot/);
		expect(result1.loopKey).toBeDefined();
		expect(result1.loopKey).toContain("cycle3|");

		// Second time: abort with same loopKey
		const result2 = isNoProgressLoop([a, b, c, a, b, c, a, b, c], new Set([result1.loopKey!]));
		expect(result2.result).toBe("abort");
		expect(result2.reason).toMatch(/Period-3 loop/);
		expect(result2.loopKey).toBe(result1.loopKey);
	});

	it("não confunde sequências diferentes com ciclo de período 3", () => {
		const a = {
			name: "action1",
			argsKey: toolArgsKey("action1", { x: 1 }),
			resultKey: toolResultKey("result1", true),
			ok: true,
		};
		const b = {
			name: "action2",
			argsKey: toolArgsKey("action2", { x: 2 }),
			resultKey: toolResultKey("result2", true),
			ok: true,
		};
		const c = {
			name: "action3",
			argsKey: toolArgsKey("action3", { x: 3 }),
			resultKey: toolResultKey("result3", true),
			ok: true,
		};
		const c2 = {
			name: "action3",
			argsKey: toolArgsKey("action3", { x: 3 }),
			resultKey: toolResultKey("result3b", true), // Resultado diferente
			ok: true,
		};
		// A, B, C, A, B, C2 - último C tem resultado diferente, não é ciclo perfeito
		const result = isNoProgressLoop([a, b, c, a, b, c2], new Set());
		expect(result.result).toBe("ok");
		expect(result.reason).toBeNull();
	});

	it("ciclo de período 3 com chave canônica é independente da rotação", () => {
		const a = {
			name: "navigate",
			argsKey: toolArgsKey("navigate", { url: "page" }),
			resultKey: toolResultKey("loaded", true),
			ok: true,
		};
		const b = {
			name: "click",
			argsKey: toolArgsKey("click", { selector: "btn" }),
			resultKey: toolResultKey("click ok", true),
			ok: true,
		};
		const c = {
			name: "screenshot",
			argsKey: toolArgsKey("screenshot", {}),
			resultKey: toolResultKey("screenshot ok", true),
			ok: true,
		};
		// Primeira detecção com [a,b,c,a,b,c,a,b,c]
		const result1 = isNoProgressLoop([a, b, c, a, b, c, a, b, c], new Set());
		expect(result1.result).toBe("warn");
		expect(result1.loopKey).toBeDefined();

		// Segunda vez com [b,c,a,b,c,a,b,c,a] (rotação diferente da janela)
		// Deve reconhecer como o mesmo ciclo pela chave canônica
		const result2 = isNoProgressLoop([b, c, a, b, c, a, b, c, a], new Set([result1.loopKey!]));
		expect(result2.result).toBe("abort");
		expect(result2.loopKey).toBe(result1.loopKey);
	});
	const mk = (name: string, args: Record<string, unknown>) => ({
		name,
		argsKey: toolArgsKey(name, args),
		resultKey: toolResultKey(`${name} ok`, true),
		ok: true,
	});

	it("janela de 10 elementos (rotação a,b,c,...,a) com a chave avisada na janela de 9 aborta", () => {
		const a = mk("navigate", { url: "page" });
		const b = mk("click", { selector: "btn" });
		const c = mk("screenshot", {});
		const warned = isNoProgressLoop([a, b, c, a, b, c, a, b, c], new Set());
		expect(warned.result).toBe("warn");
		const next = isNoProgressLoop([a, b, c, a, b, c, a, b, c, a], new Set([warned.loopKey!]));
		expect(next.result).toBe("abort");
	});

	it("ciclo de período 2 também é independente da rotação da janela", () => {
		const a = mk("click", { selector: "x" });
		const b = mk("screenshot", {});
		const warned = isNoProgressLoop([a, b, a, b, a, b], new Set());
		expect(warned.result).toBe("warn");
		expect(isNoProgressLoop([a, b, a, b, a, b, a], new Set([warned.loopKey!])).result).toBe("abort");
	});
});

describe("hasVerifiableProgress", () => {
	it("exige tool ok com resultado novo", () => {
		const a = {
			name: "navigate",
			argsKey: "navigate:{}",
			resultKey: toolResultKey("pagina 1", true),
			ok: true,
		};
		expect(hasVerifiableProgress([a], 0)).toBe(true);
		expect(hasSuccessfulToolEvidence([a])).toBe(true);
		expect(hasVerifiableProgress([], 0)).toBe(false);
	});
});
